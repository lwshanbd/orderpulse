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
import type {
  ApnsEnvironment,
  MobileDevice,
  NotificationJob,
} from "./mobile-types.js";
import type {
  OAuthTransaction,
  OrderDeliveryDetails,
  StoredOwnerTokens,
  StoredTeslaTokens,
  TeslaTokenResponse,
} from "./types.js";
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

interface OwnerTokenRow {
  access_ciphertext: string;
  refresh_ciphertext: string;
  token_type: string;
  access_expires_at: number;
  scopes: string;
  updated_at: number;
}

interface SnapshotRow {
  order_key: string;
  reference_suffix: string | null;
  order_status: string | null;
  order_substatus: string | null;
  model_code: string | null;
  market_options_json: string;
  delivery_details_json: string | null;
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

interface PairingCodeRow {
  code_hash: string;
  expires_at: number;
  used_at: number | null;
}

interface MobileDeviceRow {
  id: string;
  name: string;
  apns_token_ciphertext: string | null;
  apns_environment: ApnsEnvironment | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

interface NotificationJobRow extends EventRow {
  device_id: string;
  apns_token_ciphertext: string;
  apns_environment: ApnsEnvironment;
  attempt_count: number;
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

function parseDeliveryDetails(value: string | null): OrderDeliveryDetails | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as OrderDeliveryDetails
      : null;
  } catch {
    return null;
  }
}

function deliverySummary(value: string | null): string | null {
  const delivery = parseDeliveryDetails(value);
  if (!delivery) return null;
  if (delivery.appointment) return `Delivery appointment: ${delivery.appointment}`;
  if (delivery.deliveryWindow) return `Delivery window: ${delivery.deliveryWindow}`;
  if (delivery.etaToDeliveryCenter) return `ETA to delivery center: ${delivery.etaToDeliveryCenter}`;
  if (delivery.vinAssigned) return "VIN assigned";
  if (delivery.pendingTaskCount > 0) return `${delivery.pendingTaskCount} app tasks pending`;
  return "Delivery details updated";
}

function snapshotFromRow(row: SnapshotRow): OrderSnapshot {
  return {
    orderId: row.order_key,
    referenceNumber: maskedReference(row.reference_suffix),
    orderStatus: row.order_status,
    orderSubstatus: row.order_substatus,
    modelCode: row.model_code,
    marketOptions: parseMarketOptions(row.market_options_json),
    delivery: parseDeliveryDetails(row.delivery_details_json),
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

function mobileDeviceFromRow(row: MobileDeviceRow): MobileDevice {
  return {
    id: row.id,
    name: row.name,
    pushEnabled: row.apns_token_ciphertext !== null,
    apnsEnvironment: row.apns_environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
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

      CREATE TABLE IF NOT EXISTS owner_tokens (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        access_ciphertext TEXT NOT NULL,
        refresh_ciphertext TEXT NOT NULL,
        token_type TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        scopes TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS order_snapshots (
        order_key TEXT PRIMARY KEY,
        reference_suffix TEXT,
        order_status TEXT,
        order_substatus TEXT,
        model_code TEXT,
        market_options_json TEXT NOT NULL,
        delivery_details_json TEXT,
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

      CREATE TABLE IF NOT EXISTS mobile_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS mobile_pairing_codes_expires_at_idx
        ON mobile_pairing_codes(expires_at);

      CREATE TABLE IF NOT EXISTS mobile_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        apns_token_ciphertext TEXT,
        apns_environment TEXT CHECK (apns_environment IN ('sandbox', 'production')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        event_id INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
        last_error TEXT,
        next_attempt_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, device_id),
        FOREIGN KEY (event_id) REFERENCES order_events(id) ON DELETE CASCADE,
        FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS notification_deliveries_retry_idx
        ON notification_deliveries(status, next_attempt_at);
    `);

    const snapshotColumns = this.#database
      .prepare("PRAGMA table_info(order_snapshots)")
      .all() as Array<{ name: string }>;
    if (!snapshotColumns.some((column) => column.name === "delivery_details_json")) {
      this.#database.exec(
        "ALTER TABLE order_snapshots ADD COLUMN delivery_details_json TEXT",
      );
    }
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

  saveOwnerTokens(input: {
    tokens: TeslaTokenResponse;
    previousRefreshToken?: string;
  }): void {
    const refreshToken = input.tokens.refresh_token ?? input.previousRefreshToken;
    if (!refreshToken) throw new Error("Tesla Owner did not return a refresh token");
    const now = Date.now();
    this.#database
      .prepare(
        `INSERT INTO owner_tokens (
          singleton_id, access_ciphertext, refresh_ciphertext, token_type,
          access_expires_at, scopes, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          access_ciphertext = excluded.access_ciphertext,
          refresh_ciphertext = excluded.refresh_ciphertext,
          token_type = excluded.token_type,
          access_expires_at = excluded.access_expires_at,
          scopes = excluded.scopes,
          updated_at = excluded.updated_at`,
      )
      .run(
        this.#secrets.encrypt(input.tokens.access_token),
        this.#secrets.encrypt(refreshToken),
        input.tokens.token_type,
        now + input.tokens.expires_in * 1_000,
        input.tokens.scope ?? "openid email offline_access",
        now,
      );
  }

  loadOwnerTokens(): StoredOwnerTokens | null {
    const row = this.#database
      .prepare(
        `SELECT access_ciphertext, refresh_ciphertext, token_type,
                access_expires_at, scopes, updated_at
         FROM owner_tokens WHERE singleton_id = 1`,
      )
      .get() as unknown as OwnerTokenRow | undefined;
    if (!row) return null;
    return {
      accessToken: this.#secrets.decrypt(row.access_ciphertext),
      refreshToken: this.#secrets.decrypt(row.refresh_ciphertext),
      tokenType: row.token_type,
      accessExpiresAt: row.access_expires_at,
      scopes: row.scopes,
      updatedAt: row.updated_at,
    };
  }

  hasOwnerTokens(): boolean {
    const row = this.#database
      .prepare("SELECT 1 AS present FROM owner_tokens WHERE singleton_id = 1")
      .get() as { present: number } | undefined;
    return row?.present === 1;
  }

  deleteOwnerTokens(): void {
    this.#database.prepare("DELETE FROM owner_tokens WHERE singleton_id = 1").run();
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
                model_code, market_options_json, delivery_details_json,
                first_seen_at, last_seen_at,
                last_changed_at, missing_count, inactive_at
         FROM order_snapshots WHERE order_key = ?`,
      );
      const insertSnapshot = this.#database.prepare(
        `INSERT INTO order_snapshots (
          order_key, reference_suffix, order_status, order_substatus, model_code,
          market_options_json, delivery_details_json, first_seen_at, last_seen_at, last_changed_at,
          missing_count, inactive_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      );
      const updateSeenSnapshot = this.#database.prepare(
        `UPDATE order_snapshots SET
          reference_suffix = ?, order_status = ?, order_substatus = ?, model_code = ?,
          market_options_json = ?, delivery_details_json = ?, last_seen_at = ?, last_changed_at = ?,
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
        const suppliedDeliveryDetailsJson =
          order.delivery === null ? null : JSON.stringify(order.delivery);
        if (!existing) {
          insertSnapshot.run(
            order.orderKey,
            order.referenceSuffix,
            order.orderStatus,
            order.orderSubstatus,
            order.modelCode,
            marketOptionsJson,
            suppliedDeliveryDetailsJson,
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

        // A Fleet API fallback has no delivery payload. Preserve the last Owner
        // snapshot instead of treating that absence as a real Tesla change.
        const deliveryDetailsJson =
          suppliedDeliveryDetailsJson ?? existing.delivery_details_json;

        const statusChanged =
          existing.order_status !== order.orderStatus ||
          existing.order_substatus !== order.orderSubstatus;
        const configurationChanged =
          existing.model_code !== order.modelCode ||
          existing.market_options_json !== marketOptionsJson;
        const deliveryInitialized =
          existing.delivery_details_json === null && deliveryDetailsJson !== null;
        const deliveryChanged =
          existing.delivery_details_json !== deliveryDetailsJson && !deliveryInitialized;
        const reappeared = existing.inactive_at !== null;
        const materiallyChanged =
          statusChanged || configurationChanged || deliveryChanged || reappeared;

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
        } else if (deliveryChanged) {
          addEvent({
            orderKey: order.orderKey,
            type: "configuration_changed",
            previousStatus: existing.order_status,
            previousSubstatus: deliverySummary(existing.delivery_details_json),
            currentStatus: order.orderStatus,
            currentSubstatus: deliverySummary(deliveryDetailsJson),
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
          deliveryDetailsJson,
          now,
          materiallyChanged ? now : existing.last_changed_at,
          order.orderKey,
        );
      }

      const activeRows = this.#database
        .prepare(
          `SELECT order_key, reference_suffix, order_status, order_substatus,
                  model_code, market_options_json, delivery_details_json,
                  first_seen_at, last_seen_at,
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
                model_code, market_options_json, delivery_details_json,
                first_seen_at, last_seen_at,
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

  createMobilePairingCode(codeHash: string, expiresAt: number, now = Date.now()): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM mobile_pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL")
        .run(now);
      this.#database
        .prepare(
          `INSERT INTO mobile_pairing_codes (code_hash, created_at, expires_at)
           VALUES (?, ?, ?)`,
        )
        .run(codeHash, now, expiresAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pairMobileDevice(input: {
    codeHash: string;
    deviceId: string;
    credentialHash: string;
    name: string;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const code = this.#database
        .prepare(
          `SELECT code_hash, expires_at, used_at
           FROM mobile_pairing_codes WHERE code_hash = ?`,
        )
        .get(input.codeHash) as unknown as PairingCodeRow | undefined;
      if (!code || code.used_at !== null || code.expires_at <= now) {
        this.#database.exec("ROLLBACK");
        return false;
      }

      this.#database
        .prepare("UPDATE mobile_pairing_codes SET used_at = ? WHERE code_hash = ?")
        .run(now, input.codeHash);
      this.#database
        .prepare(
          `INSERT INTO mobile_devices (
            id, name, credential_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.deviceId, input.name, input.credentialHash, now, now);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  authenticateMobileDevice(credentialHash: string): string | null {
    const row = this.#database
      .prepare(
        `SELECT id FROM mobile_devices
         WHERE credential_hash = ? AND revoked_at IS NULL`,
      )
      .get(credentialHash) as { id: string } | undefined;
    return row?.id ?? null;
  }

  registerMobilePushToken(
    deviceId: string,
    deviceToken: string,
    environment: ApnsEnvironment,
    now = Date.now(),
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE mobile_devices SET
          apns_token_ciphertext = ?, apns_environment = ?, updated_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(this.#secrets.encrypt(deviceToken), environment, now, deviceId);
    return result.changes === 1;
  }

  removeMobilePushToken(deviceId: string, now = Date.now()): void {
    this.#database
      .prepare(
        `UPDATE mobile_devices SET
          apns_token_ciphertext = NULL, apns_environment = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, deviceId);
  }

  listMobileDevices(): MobileDevice[] {
    const rows = this.#database
      .prepare(
        `SELECT id, name, apns_token_ciphertext, apns_environment,
                created_at, updated_at, revoked_at
         FROM mobile_devices ORDER BY created_at DESC`,
      )
      .all() as unknown as MobileDeviceRow[];
    return rows.map(mobileDeviceFromRow);
  }

  revokeMobileDevice(deviceId: string, now = Date.now()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE mobile_devices SET
          revoked_at = ?, updated_at = ?, apns_token_ciphertext = NULL,
          apns_environment = NULL
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(now, now, deviceId);
    return result.changes === 1;
  }

  mobileDeviceNotificationTarget(deviceId: string): NotificationJob | null {
    const row = this.#database
      .prepare(
        `SELECT 0 AS id, '' AS order_key, NULL AS reference_suffix,
                'baseline_created' AS event_type, NULL AS previous_status,
                NULL AS previous_substatus, NULL AS current_status,
                NULL AS current_substatus, 0 AS notification_eligible,
                NULL AS notification_delivered_at, ? AS created_at,
                id AS device_id, apns_token_ciphertext, apns_environment,
                0 AS attempt_count
         FROM mobile_devices
         WHERE id = ? AND revoked_at IS NULL
           AND apns_token_ciphertext IS NOT NULL AND apns_environment IS NOT NULL`,
      )
      .get(Date.now(), deviceId) as unknown as NotificationJobRow | undefined;
    return row ? this.#notificationJobFromRow(row) : null;
  }

  listPendingNotificationJobs(limit = 50, now = Date.now()): NotificationJob[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const rows = this.#database
      .prepare(
        `SELECT e.id, e.order_key, s.reference_suffix, e.event_type,
                e.previous_status, e.previous_substatus,
                e.current_status, e.current_substatus,
                e.notification_eligible, e.notification_delivered_at, e.created_at,
                d.id AS device_id, d.apns_token_ciphertext, d.apns_environment,
                COALESCE(nd.attempt_count, 0) AS attempt_count
         FROM order_events e
         JOIN order_snapshots s ON s.order_key = e.order_key
         CROSS JOIN mobile_devices d
         LEFT JOIN notification_deliveries nd
           ON nd.event_id = e.id AND nd.device_id = d.id
         WHERE e.notification_eligible = 1
           AND e.created_at >= d.created_at
           AND d.revoked_at IS NULL
           AND d.apns_token_ciphertext IS NOT NULL
           AND d.apns_environment IS NOT NULL
           AND (
             nd.event_id IS NULL OR
             (nd.status = 'failed' AND nd.attempt_count < 5 AND nd.next_attempt_at <= ?)
           )
         ORDER BY e.created_at ASC, e.id ASC
         LIMIT ?`,
      )
      .all(now, safeLimit) as unknown as NotificationJobRow[];
    return rows.map((row) => this.#notificationJobFromRow(row));
  }

  #notificationJobFromRow(row: NotificationJobRow): NotificationJob {
    return {
      event: eventFromRow(row),
      deviceId: row.device_id,
      deviceToken: this.#secrets.decrypt(row.apns_token_ciphertext),
      environment: row.apns_environment,
      attemptCount: row.attempt_count,
    };
  }

  recordNotificationDelivery(input: {
    eventId: number;
    deviceId: string;
    accepted: boolean;
    errorCode: string | null;
    permanentFailure: boolean;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    const existing = this.#database
      .prepare(
        `SELECT attempt_count FROM notification_deliveries
         WHERE event_id = ? AND device_id = ?`,
      )
      .get(input.eventId, input.deviceId) as { attempt_count: number } | undefined;
    const attemptCount = (existing?.attempt_count ?? 0) + 1;
    const retryDelay = Math.min(5 * 60_000 * 2 ** (attemptCount - 1), 6 * 60 * 60_000);
    const nextAttemptAt = input.accepted || input.permanentFailure ? null : now + retryDelay;
    const status = input.accepted ? "sent" : "failed";
    const errorCode = input.errorCode?.slice(0, 100) ?? null;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO notification_deliveries (
            event_id, device_id, status, attempt_count,
            last_error, next_attempt_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id, device_id) DO UPDATE SET
            status = excluded.status,
            attempt_count = excluded.attempt_count,
            last_error = excluded.last_error,
            next_attempt_at = excluded.next_attempt_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.eventId,
          input.deviceId,
          status,
          attemptCount,
          errorCode,
          nextAttemptAt,
          now,
        );
      if (input.accepted) {
        this.#database
          .prepare(
            `UPDATE order_events
             SET notification_delivered_at = COALESCE(notification_delivered_at, ?)
             WHERE id = ?`,
          )
          .run(now, input.eventId);
      }
      if (input.permanentFailure) {
        this.removeMobilePushToken(input.deviceId, now);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
