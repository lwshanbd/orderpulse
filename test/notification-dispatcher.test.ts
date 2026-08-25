import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";
import type { PushMessage, PushResult, PushSender } from "../src/mobile-types.js";
import { NotificationDispatcher } from "../src/notification-dispatcher.js";
import { OrderIdentity } from "../src/order-identity.js";

class RecordingPushSender implements PushSender {
  readonly messages: PushMessage[] = [];
  result: PushResult = { accepted: true, errorCode: null, permanentFailure: false };

  async send(message: PushMessage): Promise<PushResult> {
    this.messages.push(message);
    return this.result;
  }
}

test("new status events are delivered once and APNs tokens stay encrypted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-push-"));
  const databasePath = join(directory, "orderpulse.sqlite");
  const key = randomBytes(32);
  const database = new OrderPulseDatabase(databasePath, new SecretBox(key));
  const identity = new OrderIdentity(key);
  const initial = identity.normalize({
    referenceNumber: "RN123456789",
    orderStatus: "BOOKED",
    orderSubstatus: "AWAITING_VIN",
  });
  assert.ok(initial);
  database.reconcileOrders([initial], 3, 1_000);

  database.createMobilePairingCode("code-hash", 10_000, 1_100);
  assert.equal(database.pairMobileDevice({
    codeHash: "code-hash",
    deviceId: "device-id",
    credentialHash: "credential-hash",
    name: "Test iPhone",
    now: 1_200,
  }), true);
  const rawPushToken = "cd".repeat(32);
  assert.equal(database.registerMobilePushToken("device-id", rawPushToken, "sandbox", 1_300), true);

  const changed = identity.normalize({
    referenceNumber: "RN123456789",
    orderStatus: "BOOKED",
    orderSubstatus: "VIN_ASSIGNED",
  });
  assert.ok(changed);
  database.reconcileOrders([changed], 3, 2_000);

  const sender = new RecordingPushSender();
  const dispatcher = new NotificationDispatcher(database, sender);
  assert.equal(await dispatcher.deliverPending(), 1);
  assert.equal(sender.messages.length, 1);
  assert.match(sender.messages[0]?.body ?? "", /AWAITING_VIN.*VIN_ASSIGNED/);
  assert.equal(database.listOrderEvents()[0]?.notificationDeliveredAt !== null, true);
  assert.equal(await dispatcher.deliverPending(), 0);

  database.close();
  const rawDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const row = rawDatabase
    .prepare("SELECT apns_token_ciphertext FROM mobile_devices WHERE id = 'device-id'")
    .get() as { apns_token_ciphertext: string };
  rawDatabase.close();
  assert.doesNotMatch(row.apns_token_ciphertext, new RegExp(rawPushToken));
});

test("a permanent APNs token error disables push for that device", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-push-invalid-"));
  const key = randomBytes(32);
  const database = new OrderPulseDatabase(join(directory, "orderpulse.sqlite"), new SecretBox(key));
  const identity = new OrderIdentity(key);
  database.createMobilePairingCode("pair", 10_000, 1_000);
  database.pairMobileDevice({
    codeHash: "pair",
    deviceId: "device",
    credentialHash: "credential",
    name: "iPhone",
    now: 1_100,
  });
  database.registerMobilePushToken("device", "ef".repeat(32), "sandbox", 1_200);
  const baseline = identity.normalize({ referenceNumber: "RN42", orderStatus: "FIRST" });
  assert.ok(baseline);
  database.reconcileOrders([baseline], 3, 1_300);
  const changed = identity.normalize({ referenceNumber: "RN42", orderStatus: "SECOND" });
  assert.ok(changed);
  database.reconcileOrders([changed], 3, 1_400);

  const sender = new RecordingPushSender();
  sender.result = {
    accepted: false,
    errorCode: "Unregistered",
    permanentFailure: true,
  };
  const dispatcher = new NotificationDispatcher(database, sender);
  assert.equal(await dispatcher.deliverPending(), 0);
  assert.equal(database.listMobileDevices()[0]?.pushEnabled, false);
  database.close();
});
