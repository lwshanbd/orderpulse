import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { describeShape, sanitizeOrder } from "../src/redact.js";

function developmentEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://orderpulse.baodishan.com",
    ADMIN_PASSWORD: "a-long-development-password",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    TESLA_CLIENT_ID: "client-id",
    TESLA_CLIENT_SECRET: "client-secret",
  };
}

test("configuration limits OAuth scopes to order-read requirements", () => {
  assert.throws(
    () => loadConfig({ ...developmentEnvironment(), TESLA_SCOPES: "openid offline_access user_data vehicle_location" }),
    /unnecessary or unsupported scope/,
  );

  const config = loadConfig(developmentEnvironment());
  assert.deepEqual(config.teslaScopes, [
    "openid",
    "offline_access",
    "user_data",
    "vehicle_device_data",
  ]);
  assert.equal(config.redirectUri, "https://orderpulse.baodishan.com/oauth/tesla/callback");
  assert.equal(config.orderPollingEnabled, false);
  assert.equal(config.orderPollingIntervalSeconds, 1_800);
  assert.equal(config.orderMissingThreshold, 3);
});

test("polling configuration is explicit and validated", () => {
  const config = loadConfig({
    ...developmentEnvironment(),
    ORDER_POLLING_ENABLED: "true",
    ORDER_POLL_INTERVAL_SECONDS: "900",
    ORDER_POLL_JITTER_SECONDS: "0",
    ORDER_MISSING_THRESHOLD: "4",
  });
  assert.equal(config.orderPollingEnabled, true);
  assert.equal(config.orderPollingIntervalSeconds, 900);
  assert.equal(config.orderPollingJitterSeconds, 0);
  assert.equal(config.orderMissingThreshold, 4);
  assert.throws(
    () => loadConfig({ ...developmentEnvironment(), ORDER_POLLING_ENABLED: "yes" }),
    /boolean/,
  );
});

test("production requires secrets to come from files", () => {
  assert.throws(
    () => loadConfig({ ...developmentEnvironment(), NODE_ENV: "production" }),
    /ADMIN_PASSWORD must be supplied through ADMIN_PASSWORD_FILE/,
  );
});

test("order output masks identifiers and schema output contains no values", () => {
  const order = {
    referenceNumber: "RN123456789",
    vin: "5YJ12345678901234",
    orderStatus: "BOOKED",
    orderSubstatus: "AWAITING_VIN",
    modelCode: "m3",
    mktOptions: "PPSW, $MT322",
    delivery: { street: "123 Private Road", appointment: null },
  };
  const sanitized = sanitizeOrder(order);

  assert.equal(sanitized.referenceNumber, "•••••••6789");
  assert.equal(sanitized.vin, "•••••••••••901234");
  assert.equal(sanitized.orderStatus, "BOOKED");
  assert.equal(sanitized.orderSubstatus, "AWAITING_VIN");
  assert.deepEqual(sanitized.marketOptions, ["PPSW", "$MT322"]);

  const shape = describeShape([order]);
  const serialized = JSON.stringify(shape);
  assert.match(serialized, /delivery\.street/);
  assert.doesNotMatch(serialized, /123 Private Road|RN123456789|5YJ12345678901234/);
});
