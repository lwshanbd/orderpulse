import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";
import { OrderIdentity } from "../src/order-identity.js";

test("order snapshots detect changes without persisting the full reference number", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-orders-"));
  const databasePath = join(directory, "orderpulse.sqlite");
  const masterKey = randomBytes(32);
  const database = new OrderPulseDatabase(databasePath, new SecretBox(masterKey));
  const identity = new OrderIdentity(masterKey);
  const rawReference = "RN123456789";
  const baseline = identity.normalize({
    referenceNumber: rawReference,
    orderStatus: "BOOKED",
    orderSubstatus: "AWAITING_VIN",
    modelCode: "m3",
    mktOptions: "PPSW, MT322",
  });
  assert.ok(baseline);

  const first = database.reconcileOrders([baseline], 3, 1_000);
  assert.deepEqual(first, {
    baselineCount: 1,
    eventCount: 1,
    notificationEligibleCount: 0,
    activeOrderCount: 1,
  });
  assert.equal(database.listOrderSnapshots()[0]?.referenceNumber, "••••6789");
  assert.equal(database.listOrderEvents()[0]?.type, "baseline_created");

  const unchanged = database.reconcileOrders([baseline], 3, 2_000);
  assert.equal(unchanged.eventCount, 0);

  const changed = identity.normalize({
    referenceNumber: rawReference,
    orderStatus: "BOOKED",
    orderSubstatus: "VIN_ASSIGNED",
    modelCode: "m3",
    mktOptions: ["MT322", "PPSW"],
  });
  assert.ok(changed);
  const changedResult = database.reconcileOrders([changed], 3, 3_000);
  assert.equal(changedResult.notificationEligibleCount, 1);
  const statusEvent = database.listOrderEvents()[0];
  assert.equal(statusEvent?.type, "status_changed");
  assert.equal(statusEvent?.previousSubstatus, "AWAITING_VIN");
  assert.equal(statusEvent?.currentSubstatus, "VIN_ASSIGNED");

  assert.equal(database.reconcileOrders([], 3, 4_000).eventCount, 0);
  assert.equal(database.reconcileOrders([], 3, 5_000).eventCount, 0);
  const inactive = database.reconcileOrders([], 3, 6_000);
  assert.equal(inactive.notificationEligibleCount, 1);
  assert.equal(database.listOrderSnapshots()[0]?.inactiveAt, 6_000);
  assert.equal(database.listOrderEvents()[0]?.type, "order_inactive");

  assert.equal(database.reconcileOrders([], 3, 7_000).eventCount, 0);
  const reappeared = database.reconcileOrders([changed], 3, 8_000);
  assert.equal(reappeared.notificationEligibleCount, 1);
  assert.equal(database.listOrderEvents()[0]?.type, "order_reappeared");
  assert.equal(database.listOrderSnapshots()[0]?.inactiveAt, null);
  database.close();

  const rawDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const persisted = JSON.stringify({
    snapshots: rawDatabase.prepare("SELECT * FROM order_snapshots").all(),
    events: rawDatabase.prepare("SELECT * FROM order_events").all(),
  });
  rawDatabase.close();
  assert.doesNotMatch(persisted, new RegExp(rawReference));
});

test("orders without a stable Tesla identifier are rejected before reconciliation", () => {
  const identity = new OrderIdentity(randomBytes(32));
  assert.equal(identity.normalize({ orderStatus: "BOOKED" }), null);

  const first = identity.normalize({ referenceNumber: "RN00001234", mktOptions: "B,A,A" });
  const second = identity.normalize({ referenceNumber: "RN00001234", mktOptions: ["A", "B"] });
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.orderKey, second.orderKey);
  assert.deepEqual(first.marketOptions, ["A", "B"]);
});
