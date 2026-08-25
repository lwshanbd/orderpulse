import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthTransaction, StoredTeslaTokens, TeslaTokenResponse } from "./types.js";
import { SecretBox } from "./crypto.js";

interface OAuthRow {
  state: string;
  nonce_ciphertext: string;
  created_at: number;
}

interface TokenRow {
  access_ciphertext: string;
  refresh_ciphertext: string;
  token_type: string;
  access_expires_at: number;
  scopes: string;
  fleet_base_url: string;
  subject: string | null;
  updated_at: number;
}

export class OrderPulseDatabase {
  readonly #database: DatabaseSync;
  readonly #secrets: SecretBox;

  constructor(path: string, secrets: SecretBox) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#secrets = secrets;
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_transactions (
        state TEXT PRIMARY KEY,
        nonce_ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tesla_tokens (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        access_ciphertext TEXT NOT NULL,
        refresh_ciphertext TEXT NOT NULL,
        token_type TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        scopes TEXT NOT NULL,
        fleet_base_url TEXT NOT NULL,
        subject TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  createOAuthTransaction(transaction: OAuthTransaction): void {
    const cutoff = transaction.createdAt - 86_400_000;
    this.#database
      .prepare("DELETE FROM oauth_transactions WHERE created_at < ?")
      .run(cutoff);
    this.#database
      .prepare(
        `INSERT INTO oauth_transactions (state, nonce_ciphertext, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(transaction.state, this.#secrets.encrypt(transaction.nonce), transaction.createdAt);
  }

  consumeOAuthTransaction(state: string, ttlSeconds: number): OAuthTransaction | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          `SELECT state, nonce_ciphertext, created_at
           FROM oauth_transactions
           WHERE state = ?`,
        )
        .get(state) as unknown as OAuthRow | undefined;

      this.#database.prepare("DELETE FROM oauth_transactions WHERE state = ?").run(state);
      this.#database.exec("COMMIT");

      if (!row || Date.now() - row.created_at > ttlSeconds * 1000) {
        return null;
      }

      return {
        state: row.state,
        nonce: this.#secrets.decrypt(row.nonce_ciphertext),
        createdAt: row.created_at,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  saveTeslaTokens(input: {
    tokens: TeslaTokenResponse;
    previousRefreshToken?: string;
    fleetBaseUrl: string;
    subject: string | null;
  }): void {
    const refreshToken = input.tokens.refresh_token ?? input.previousRefreshToken;
    if (!refreshToken) {
      throw new Error("Tesla did not return a refresh token");
    }
    const now = Date.now();
    const expiresAt = now + input.tokens.expires_in * 1000;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO tesla_tokens (
            singleton_id, access_ciphertext, refresh_ciphertext, token_type,
            access_expires_at, scopes, fleet_base_url, subject, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton_id) DO UPDATE SET
            access_ciphertext = excluded.access_ciphertext,
            refresh_ciphertext = excluded.refresh_ciphertext,
            token_type = excluded.token_type,
            access_expires_at = excluded.access_expires_at,
            scopes = excluded.scopes,
            fleet_base_url = excluded.fleet_base_url,
            subject = excluded.subject,
            updated_at = excluded.updated_at`,
        )
        .run(
          this.#secrets.encrypt(input.tokens.access_token),
          this.#secrets.encrypt(refreshToken),
          input.tokens.token_type,
          expiresAt,
          input.tokens.scope ?? "",
          input.fleetBaseUrl,
          input.subject,
          now,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  loadTeslaTokens(): StoredTeslaTokens | null {
    const row = this.#database
      .prepare(
        `SELECT access_ciphertext, refresh_ciphertext, token_type,
                access_expires_at, scopes, fleet_base_url, subject, updated_at
         FROM tesla_tokens WHERE singleton_id = 1`,
      )
      .get() as unknown as TokenRow | undefined;

    if (!row) return null;
    return {
      accessToken: this.#secrets.decrypt(row.access_ciphertext),
      refreshToken: this.#secrets.decrypt(row.refresh_ciphertext),
      tokenType: row.token_type,
      accessExpiresAt: row.access_expires_at,
      scopes: row.scopes,
      fleetBaseUrl: row.fleet_base_url,
      subject: row.subject,
      updatedAt: row.updated_at,
    };
  }

  updateFleetBaseUrl(fleetBaseUrl: string): void {
    this.#database
      .prepare("UPDATE tesla_tokens SET fleet_base_url = ?, updated_at = ? WHERE singleton_id = 1")
      .run(fleetBaseUrl, Date.now());
  }

  updateScopes(scopes: string): void {
    this.#database
      .prepare("UPDATE tesla_tokens SET scopes = ? WHERE singleton_id = 1")
      .run(scopes);
  }

  hasTeslaTokens(): boolean {
    const row = this.#database
      .prepare("SELECT 1 AS present FROM tesla_tokens WHERE singleton_id = 1")
      .get() as { present: number } | undefined;
    return row?.present === 1;
  }

  deleteTeslaTokens(): void {
    this.#database.prepare("DELETE FROM tesla_tokens WHERE singleton_id = 1").run();
  }

  close(): void {
    this.#database.close();
  }
}
