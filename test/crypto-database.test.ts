import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";

test("SecretBox encrypts and authenticates values", () => {
  const box = new SecretBox(randomBytes(32));
  const encrypted = box.encrypt("highly-sensitive-token");

  assert.notEqual(encrypted, "highly-sensitive-token");
  assert.equal(box.decrypt(encrypted), "highly-sensitive-token");

  const parts = encrypted.split(":");
  const ciphertext = parts.at(-1);
  assert.ok(ciphertext);
  parts[parts.length - 1] = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
  assert.throws(() => box.decrypt(parts.join(":")));
});

test("database stores OAuth nonces and Tesla tokens as ciphertext", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-db-"));
  const databasePath = join(directory, "orderpulse.sqlite");
  const database = new OrderPulseDatabase(databasePath, new SecretBox(randomBytes(32)));

  database.createOAuthTransaction({ state: "state-value", nonce: "nonce-value", createdAt: Date.now() });
  database.saveTeslaTokens({
    tokens: {
      access_token: "plain-access-token",
      refresh_token: "plain-refresh-token",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid offline_access user_data vehicle_device_data",
    },
    fleetBaseUrl: "https://fleet-api.prd.na.vn.cloud.tesla.com",
    subject: "subject",
  });
  database.saveOwnerTokens({
    tokens: {
      access_token: "plain-owner-access-token",
      refresh_token: "plain-owner-refresh-token",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid email offline_access",
    },
  });

  const stored = database.loadTeslaTokens();
  assert.equal(stored?.accessToken, "plain-access-token");
  assert.equal(stored?.refreshToken, "plain-refresh-token");
  assert.equal(database.loadOwnerTokens()?.accessToken, "plain-owner-access-token");
  database.close();

  const rawDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const oauthRow = rawDatabase.prepare("SELECT nonce_ciphertext FROM oauth_transactions").get() as
    | { nonce_ciphertext: string }
    | undefined;
  const tokenRow = rawDatabase
    .prepare("SELECT access_ciphertext, refresh_ciphertext FROM tesla_tokens")
    .get() as { access_ciphertext: string; refresh_ciphertext: string } | undefined;
  const ownerTokenRow = rawDatabase
    .prepare("SELECT access_ciphertext, refresh_ciphertext FROM owner_tokens")
    .get() as { access_ciphertext: string; refresh_ciphertext: string } | undefined;
  rawDatabase.close();

  assert.ok(oauthRow);
  assert.ok(tokenRow);
  assert.ok(ownerTokenRow);
  assert.doesNotMatch(oauthRow.nonce_ciphertext, /nonce-value/);
  assert.doesNotMatch(tokenRow.access_ciphertext, /plain-access-token/);
  assert.doesNotMatch(tokenRow.refresh_ciphertext, /plain-refresh-token/);
  assert.doesNotMatch(ownerTokenRow.access_ciphertext, /plain-owner-access-token/);
  assert.doesNotMatch(ownerTokenRow.refresh_ciphertext, /plain-owner-refresh-token/);
});

test("OAuth state is one-time and expires", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-state-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );

  database.createOAuthTransaction({ state: "once", nonce: "nonce", createdAt: Date.now() });
  assert.equal(database.consumeOAuthTransaction("once", 600)?.nonce, "nonce");
  assert.equal(database.consumeOAuthTransaction("once", 600), null);

  database.createOAuthTransaction({
    state: "expired",
    nonce: "nonce",
    createdAt: Date.now() - 2_000,
  });
  assert.equal(database.consumeOAuthTransaction("expired", 1), null);
  database.close();
});

test("opening a first-stage database preserves authorization and adds order tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-migration-"));
  const databasePath = join(directory, "orderpulse.sqlite");
  const key = randomBytes(32);
  const box = new SecretBox(key);
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE oauth_transactions (
      state TEXT PRIMARY KEY,
      nonce_ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE tesla_tokens (
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
  legacy
    .prepare(
      `INSERT INTO tesla_tokens VALUES (1, ?, ?, 'Bearer', ?, ?, ?, 'subject', ?)`,
    )
    .run(
      box.encrypt("existing-access"),
      box.encrypt("existing-refresh"),
      Date.now() + 3_600_000,
      "openid offline_access user_data vehicle_device_data",
      "https://fleet-api.prd.na.vn.cloud.tesla.com",
      Date.now(),
    );
  legacy.close();

  const migrated = new OrderPulseDatabase(databasePath, box);
  assert.equal(migrated.loadTeslaTokens()?.accessToken, "existing-access");
  assert.deepEqual(migrated.listOrderSnapshots(), []);
  assert.deepEqual(migrated.listOrderEvents(), []);
  migrated.close();
});

test("opening the previous order schema adds the delivery details column in place", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-delivery-migration-"));
  const databasePath = join(directory, "orderpulse.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE order_snapshots (
      order_key TEXT PRIMARY KEY,
      reference_suffix TEXT,
      order_status TEXT,
      order_substatus TEXT,
      model_code TEXT,
      market_options_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_changed_at INTEGER NOT NULL,
      missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
      inactive_at INTEGER
    ) STRICT;
    INSERT INTO order_snapshots VALUES (
      'existing-order', '1234', 'BOOKED', NULL, 'MY', '[]', 1, 1, 1, 0, NULL
    );
  `);
  legacy.close();

  const migrated = new OrderPulseDatabase(databasePath, new SecretBox(randomBytes(32)));
  const snapshot = migrated.listOrderSnapshots()[0];
  assert.equal(snapshot?.orderId, "existing-order");
  assert.equal(snapshot?.delivery, null);
  migrated.close();
});
