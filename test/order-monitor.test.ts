import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";
import { OrderIdentity } from "../src/order-identity.js";
import { OrderMonitor, type OrderProvider } from "../src/order-monitor.js";
import { TeslaRequestError } from "../src/tesla.js";
import type { TeslaOrder } from "../src/types.js";

function testMonitor(provider: OrderProvider): {
  database: OrderPulseDatabase;
  monitor: OrderMonitor;
} {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-monitor-"));
  const key = randomBytes(32);
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(key),
  );
  const monitor = new OrderMonitor({
    database,
    tokenService: provider,
    identity: new OrderIdentity(key),
    enabled: false,
    intervalSeconds: 1_800,
    jitterSeconds: 0,
    missingThreshold: 3,
    random: () => 0,
  });
  return { database, monitor };
}

test("concurrent manual polls share one Tesla request and one poll run", async () => {
  let calls = 0;
  const orders: TeslaOrder[] = [
    {
      referenceNumber: "RN123456789",
      orderStatus: "BOOKED",
      orderSubstatus: "AWAITING_VIN",
    },
  ];
  const provider: OrderProvider = {
    async getOrders() {
      calls += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return orders;
    },
  };
  const { database, monitor } = testMonitor(provider);

  const [left, right] = await Promise.all([
    monitor.pollNow("manual"),
    monitor.pollNow("live_api"),
  ]);
  assert.equal(calls, 1);
  assert.equal(left.pollRunId, right.pollRunId);
  assert.equal(left.reconciliation.baselineCount, 1);
  assert.equal(database.latestPollRun()?.outcome, "success");
  assert.equal(database.listOrderSnapshots().length, 1);
  database.close();
});

test("failed polls record only a safe error code and do not alter snapshots", async () => {
  const provider: OrderProvider = {
    async getOrders() {
      throw new TeslaRequestError({
        message: "remote detail that must not be persisted",
        status: 429,
        code: "rate_limited",
        retryAfterSeconds: 120,
      });
    },
  };
  const { database, monitor } = testMonitor(provider);
  await assert.rejects(() => monitor.pollNow("manual"), TeslaRequestError);

  assert.equal(database.latestPollRun()?.outcome, "error");
  assert.equal(database.latestPollRun()?.errorCode, "rate_limited");
  assert.equal(database.listOrderSnapshots().length, 0);
  assert.equal(monitor.status().consecutiveFailures, 1);
  database.close();
});

test("a schema change that removes stable order identity fails closed", async () => {
  const provider: OrderProvider = {
    async getOrders() {
      return [{ orderStatus: "BOOKED", orderSubstatus: "UNKNOWN_SCHEMA" }];
    },
  };
  const { database, monitor } = testMonitor(provider);
  await assert.rejects(() => monitor.pollNow("manual"), /stable identity/);
  assert.equal(database.latestPollRun()?.errorCode, "order_identity_unavailable");
  assert.equal(database.listOrderSnapshots().length, 0);
  database.close();
});
