import type { OrderPulseDatabase } from "./database.js";
import type { OrderIdentity } from "./order-identity.js";
import type {
  OrderReconciliationResult,
  PollRun,
  PollSource,
} from "./order-types.js";
import { TeslaRequestError } from "./tesla.js";
import type { TeslaOrder } from "./types.js";

const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const MAX_TIMER_MS = 24 * 60 * 60 * 1_000;

export interface OrderPollResult {
  pollRunId: number;
  orders: TeslaOrder[];
  reconciliation: OrderReconciliationResult;
  startedAt: number;
  finishedAt: number;
}

export interface OrderMonitorStatus {
  enabled: boolean;
  started: boolean;
  inProgress: boolean;
  intervalSeconds: number;
  jitterSeconds: number;
  missingThreshold: number;
  consecutiveFailures: number;
  nextPollAt: number | null;
  latestRun: PollRun | null;
}

interface OrderMonitorOptions {
  database: OrderPulseDatabase;
  tokenService: OrderProvider;
  identity: OrderIdentity;
  enabled: boolean;
  intervalSeconds: number;
  jitterSeconds: number;
  missingThreshold: number;
  notifications?: NotificationDispatching;
  random?: () => number;
}

export interface NotificationDispatching {
  deliverPending(): Promise<number>;
}

export interface OrderProvider {
  getOrders(): Promise<TeslaOrder[]>;
}

function safePollErrorCode(error: unknown): string {
  if (error instanceof TeslaRequestError) {
    return error.code ?? `tesla_http_${error.status}`;
  }
  if (error instanceof Error && error.message === "Tesla authorization is not configured") {
    return "not_authorized";
  }
  if (error instanceof Error && error.message === "Tesla order response lacks a stable identity") {
    return "order_identity_unavailable";
  }
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "internal_error";
}

export class OrderMonitor {
  readonly #database: OrderPulseDatabase;
  readonly #tokenService: OrderProvider;
  readonly #identity: OrderIdentity;
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #missingThreshold: number;
  readonly #notifications: NotificationDispatching | null;
  readonly #random: () => number;
  #started = false;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<OrderPollResult> | null = null;
  #consecutiveFailures = 0;
  #retryAfterMs = 0;
  #nextPollAt: number | null = null;

  constructor(options: OrderMonitorOptions) {
    this.#database = options.database;
    this.#tokenService = options.tokenService;
    this.#identity = options.identity;
    this.#enabled = options.enabled;
    this.#intervalMs = options.intervalSeconds * 1_000;
    this.#jitterMs = options.jitterSeconds * 1_000;
    this.#missingThreshold = options.missingThreshold;
    this.#notifications = options.notifications ?? null;
    this.#random = options.random ?? Math.random;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#enabled) {
      this.#schedule(Math.min(10_000, this.#intervalMs));
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#nextPollAt = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#inFlight) {
      try {
        await this.#inFlight;
      } catch {
        // The failed run is already recorded in poll_runs.
      }
    }
  }

  status(): OrderMonitorStatus {
    return {
      enabled: this.#enabled,
      started: this.#started,
      inProgress: this.#inFlight !== null,
      intervalSeconds: this.#intervalMs / 1_000,
      jitterSeconds: this.#jitterMs / 1_000,
      missingThreshold: this.#missingThreshold,
      consecutiveFailures: this.#consecutiveFailures,
      nextPollAt: this.#nextPollAt,
      latestRun: this.#database.latestPollRun(),
    };
  }

  pollNow(source: PollSource = "manual"): Promise<OrderPollResult> {
    if (this.#inFlight) return this.#inFlight;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#nextPollAt = null;
    }

    const task = this.#execute(source)
      .then((result) => {
        this.#consecutiveFailures = 0;
        this.#retryAfterMs = 0;
        return result;
      })
      .catch((error: unknown) => {
        this.#consecutiveFailures += 1;
        this.#retryAfterMs =
          error instanceof TeslaRequestError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1_000
            : 0;
        throw error;
      })
      .finally(() => {
        this.#inFlight = null;
        if (this.#started && this.#enabled) this.#schedule(this.#nextDelayMs());
      });
    this.#inFlight = task;
    return task;
  }

  async #execute(source: PollSource): Promise<OrderPollResult> {
    const startedAt = Date.now();
    const pollRunId = this.#database.startPollRun(source, startedAt);
    try {
      const orders = await this.#tokenService.getOrders();
      const normalized = orders.map((order) => this.#identity.normalize(order));
      if (normalized.some((order) => order === null)) {
        throw new Error("Tesla order response lacks a stable identity");
      }
      const reconciliation = this.#database.reconcileOrders(
        normalized.filter((order) => order !== null),
        this.#missingThreshold,
      );
      const finishedAt = Date.now();
      this.#database.completePollRun(pollRunId, {
        orderCount: orders.length,
        eventCount: reconciliation.eventCount,
        finishedAt,
      });
      if (this.#notifications) {
        try {
          await this.#notifications.deliverPending();
        } catch {
          // APNs failures are tracked independently and must not invalidate a Tesla poll.
        }
      }
      return { pollRunId, orders, reconciliation, startedAt, finishedAt };
    } catch (error) {
      this.#database.failPollRun(pollRunId, safePollErrorCode(error));
      throw error;
    }
  }

  #nextDelayMs(): number {
    const backoffMultiplier =
      this.#consecutiveFailures === 0
        ? 1
        : 2 ** Math.min(this.#consecutiveFailures, 4);
    const backoff = Math.min(this.#intervalMs * backoffMultiplier, MAX_BACKOFF_MS);
    const jitter = Math.floor(this.#random() * (this.#jitterMs + 1));
    return Math.min(Math.max(backoff, this.#retryAfterMs) + jitter, MAX_TIMER_MS);
  }

  #schedule(delayMs: number): void {
    const safeDelay = Math.max(Math.trunc(delayMs), 1_000);
    this.#nextPollAt = Date.now() + safeDelay;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#nextPollAt = null;
      void this.pollNow("scheduled").catch(() => undefined);
    }, safeDelay);
    this.#timer.unref();
  }
}
