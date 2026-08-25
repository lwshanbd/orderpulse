import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  OrderEvent,
  OrderEventType,
  OrderReconciliationResult,
  OrderSnapshot,
  PollOutcome,
  PollRun,
  PollSource,
  TrackedOrder,
} from "./order-types.js";
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

interface SnapshotRow {
  order_key: string;
  reference_suffix: string | null;
  order_status: string | null;
  order_substatus: string | null;
  model_code: string | null;
  market_options_json: string;
  first_seen_at: number;
  last_seen_at: number;
  last_changed_at: number;
  missing_count: number;
  inactive_at: number | null;
}

interface EventRow {
  id: number;
  order_key: string;
  reference_suffix: string | null;
  event_type: OrderEventType;
  previous_status: string | null;
  previous_substatus: string | null;
  current_status: string | null;
  current_substatus: string | null;
  notification_eligible: number;
  notification_delivered_at: number | null;
  created_at: number;
}

interface PollRunRow {
  id: number;
  source: PollSource;
  outcome: PollOutcome;
  started_at: number;
  finished_at: number | null;
  order_count: number | null;
  event_count: number | null;
  error_code: string | null;
}

function parseMarketOptions(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function maskedReference(referenceSuffix: string | null): string | null {
  return referenceSuffix ? `••••${referenceSuffix}` : null;
}

function snapshotFromRow(row: SnapshotRow): OrderSnapshot {
  return {
    orderId: row.order_key,
    referenceNumber: maskedReference(row.reference_suffix),
    orderStatus: row.order_status,
    orderSubstatus: row.order_substatus,
    modelCode: row.model_code,
    marketOptions: parseMarketOptions(row.market_options_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    missingCount: row.missing_count,
    inactiveAt: row.inactive_at,
  };
}

function eventFromRow(row: EventRow): OrderEvent {
  return {
    id: row.id,
    orderId: row.order_key,
    referenceNumber: maskedReference(row.reference_suffix),
    type: row.event_type,
    previousStatus: row.previous_status,
    previousSubstatus: row.previous_substatus,
    currentStatus: row.current_status,
    currentSubstatus: row.current_substatus,
    notificationEligible: row.notification_eligible === 1,
    notificationDeliveredAt: row.notification_delivered_at,
    createdAt: row.created_at,
  };
}

function pollRunFromRow(row: PollRunRow): PollRun {
  return {
    id: row.id,
    source: row.source,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    orderCount: row.order_count,
    eventCount: row.event_count,
    errorCode: row.error_code,
  };
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
    this.#database
      .prepare(
        `UPDATE poll_runs
         SET outcome = 'error', finished_at = ?, error_code = 'interrupted'
         WHERE outcome = 'running'`,
      )
      .run(Date.now());
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

      CREATE TABLE IF NOT EXISTS order_snapshots (
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

      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_key TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'baseline_created', 'status_changed', 'configuration_changed',
          'order_inactive', 'order_reappeared'
        )),
        previous_status TEXT,
        previous_substatus TEXT,
        current_status TEXT,
        current_substatus TEXT,
        notification_eligible INTEGER NOT NULL CHECK (notification_eligible IN (0, 1)),
        notification_delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (order_key) REFERENCES order_snapshots(order_key) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS order_events_created_at_idx
        ON order_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS poll_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual', 'live_api')),
        outcome TEXT NOT NULL CHECK (outcome IN ('running', 'success', 'error')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        order_count INTEGER,
        event_count INTEGER,
        error_code TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS poll_runs_started_at_idx
        ON poll_runs(started_at DESC);
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

  reconcileOrders(
    orders: TrackedOrder[],
    missingThreshold: number,
    now = Date.now(),
  ): OrderReconciliationResult {
    if (!Number.isSafeInteger(missingThreshold) || missingThreshold <= 0) {
      throw new Error("missingThreshold must be a positive integer");
    }

    const uniqueOrders = new Map(orders.map((order) => [order.orderKey, order]));
    const seenOrderKeys = new Set(uniqueOrders.keys());
    let baselineCount = 0;
    let eventCount = 0;
    let notificationEligibleCount = 0;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const selectSnapshot = this.#database.prepare(
        `SELECT order_key, reference_suffix, order_status, order_substatus,
                model_code, market_options_json, first_seen_at, last_seen_at,
                last_changed_at, missing_count, inactive_at
         FROM order_snapshots WHERE order_key = ?`,
      );
      const insertSnapshot = this.#database.prepare(
        `INSERT INTO order_snapshots (
          order_key, reference_suffix, order_status, order_substatus, model_code,
          market_options_json, first_seen_at, last_seen_at, last_changed_at,
          missing_count, inactive_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      );
      const updateSeenSnapshot = this.#database.prepare(
        `UPDATE order_snapshots SET
          reference_suffix = ?, order_status = ?, order_substatus = ?, model_code = ?,
          market_options_json = ?, last_seen_at = ?, last_changed_at = ?,
          missing_count = 0, inactive_at = NULL
         WHERE order_key = ?`,
      );
      const insertEvent = this.#database.prepare(
        `INSERT INTO order_events (
          order_key, event_type, previous_status, previous_substatus,
          current_status, current_substatus, notification_eligible, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const addEvent = (input: {
        orderKey: string;
        type: OrderEventType;
        previousStatus: string | null;
        previousSubstatus: string | null;
        currentStatus: string | null;
        currentSubstatus: string | null;
        notificationEligible: boolean;
      }): void => {
        insertEvent.run(
          input.orderKey,
          input.type,
          input.previousStatus,
          input.previousSubstatus,
          input.currentStatus,
          input.currentSubstatus,
          input.notificationEligible ? 1 : 0,
          now,
        );
        eventCount += 1;
        if (input.notificationEligible) notificationEligibleCount += 1;
      };

      for (const order of uniqueOrders.values()) {
        const existing = selectSnapshot.get(order.orderKey) as unknown as SnapshotRow | undefined;
        const marketOptionsJson = JSON.stringify(order.marketOptions);
        if (!existing) {
          insertSnapshot.run(
            order.orderKey,
            order.referenceSuffix,
            order.orderStatus,
            order.orderSubstatus,
            order.modelCode,
            marketOptionsJson,
            now,
            now,
            now,
          );
          baselineCount += 1;
          addEvent({
            orderKey: order.orderKey,
            type: "baseline_created",
            previousStatus: null,
            previousSubstatus: null,
            currentStatus: order.orderStatus,
            currentSubstatus: order.orderSubstatus,
            notificationEligible: false,
          });
          continue;
        }

        const statusChanged =
          existing.order_status !== order.orderStatus ||
          existing.order_substatus !== order.orderSubstatus;
        const configurationChanged =
          existing.model_code !== order.modelCode ||
          existing.market_options_json !== marketOptionsJson;
        const reappeared = existing.inactive_at !== null;
        const materiallyChanged = statusChanged || configurationChanged || reappeared;

        if (reappeared) {
          addEvent({
            orderKey: order.orderKey,
            type: "order_reappeared",
            previousStatus: existing.order_status,
            previousSubstatus: existing.order_substatus,
            currentStatus: order.orderStatus,
            currentSubstatus: order.orderSubstatus,
            notificationEligible: true,
          });
        } else if (statusChanged) {
          addEvent({
            orderKey: order.orderKey,
            type: "status_changed",
            previousStatus: existing.order_status,
            previousSubstatus: existing.order_substatus,
            currentStatus: order.orderStatus,
            currentSubstatus: order.orderSubstatus,
            notificationEligible: true,
          });
        } else if (configurationChanged) {
          addEvent({
            orderKey: order.orderKey,
            type: "configuration_changed",
            previousStatus: existing.order_status,
            previousSubstatus: existing.order_substatus,
            currentStatus: order.orderStatus,
            currentSubstatus: order.orderSubstatus,
            notificationEligible: false,
          });
        }

        updateSeenSnapshot.run(
          order.referenceSuffix,
          order.orderStatus,
          order.orderSubstatus,
          order.modelCode,
          marketOptionsJson,
          now,
          materiallyChanged ? now : existing.last_changed_at,
          order.orderKey,
        );
      }

      const activeRows = this.#database
        .prepare(
          `SELECT order_key, reference_suffix, order_status, order_substatus,
                  model_code, market_options_json, first_seen_at, last_seen_at,
                  last_changed_at, missing_count, inactive_at
           FROM order_snapshots WHERE inactive_at IS NULL`,
        )
        .all() as unknown as SnapshotRow[];
      const updateMissingCount = this.#database.prepare(
        "UPDATE order_snapshots SET missing_count = ? WHERE order_key = ?",
      );
      const markInactive = this.#database.prepare(
        `UPDATE order_snapshots
         SET missing_count = ?, inactive_at = ?, last_changed_at = ?
         WHERE order_key = ?`,
      );

      for (const row of activeRows) {
        if (seenOrderKeys.has(row.order_key)) continue;
        const missingCount = row.missing_count + 1;
        if (missingCount < missingThreshold) {
          updateMissingCount.run(missingCount, row.order_key);
          continue;
        }

        markInactive.run(missingCount, now, now, row.order_key);
        addEvent({
          orderKey: row.order_key,
          type: "order_inactive",
          previousStatus: row.order_status,
          previousSubstatus: row.order_substatus,
          currentStatus: null,
          currentSubstatus: null,
          notificationEligible: true,
        });
      }

      this.#database.exec("COMMIT");
      return {
        baselineCount,
        eventCount,
        notificationEligibleCount,
        activeOrderCount: uniqueOrders.size,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listOrderSnapshots(): OrderSnapshot[] {
    const rows = this.#database
      .prepare(
        `SELECT order_key, reference_suffix, order_status, order_substatus,
                model_code, market_options_json, first_seen_at, last_seen_at,
                last_changed_at, missing_count, inactive_at
         FROM order_snapshots
         ORDER BY inactive_at IS NOT NULL, last_changed_at DESC`,
      )
      .all() as unknown as SnapshotRow[];
    return rows.map(snapshotFromRow);
  }

  listOrderEvents(limit = 50): OrderEvent[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.#database
      .prepare(
        `SELECT e.id, e.order_key, s.reference_suffix, e.event_type,
                e.previous_status, e.previous_substatus,
                e.current_status, e.current_substatus,
                e.notification_eligible, e.notification_delivered_at, e.created_at
         FROM order_events e
         JOIN order_snapshots s ON s.order_key = e.order_key
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`,
      )
      .all(safeLimit) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  startPollRun(source: PollSource, startedAt = Date.now()): number {
    const result = this.#database
      .prepare(
        `INSERT INTO poll_runs (source, outcome, started_at)
         VALUES (?, 'running', ?)`,
      )
      .run(source, startedAt);
    return Number(result.lastInsertRowid);
  }

  completePollRun(
    id: number,
    input: { orderCount: number; eventCount: number; finishedAt?: number },
  ): void {
    this.#database
      .prepare(
        `UPDATE poll_runs SET outcome = 'success', finished_at = ?,
          order_count = ?, event_count = ?, error_code = NULL
         WHERE id = ?`,
      )
      .run(input.finishedAt ?? Date.now(), input.orderCount, input.eventCount, id);
  }

  failPollRun(id: number, errorCode: string, finishedAt = Date.now()): void {
    this.#database
      .prepare(
        `UPDATE poll_runs SET outcome = 'error', finished_at = ?, error_code = ?
         WHERE id = ?`,
      )
      .run(finishedAt, errorCode.slice(0, 100), id);
  }

  latestPollRun(): PollRun | null {
    const row = this.#database
      .prepare(
        `SELECT id, source, outcome, started_at, finished_at,
                order_count, event_count, error_code
         FROM poll_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get() as unknown as PollRunRow | undefined;
    return row ? pollRunFromRow(row) : null;
  }

  close(): void {
    this.#database.close();
  }
}
