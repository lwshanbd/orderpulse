import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { ServiceConfig } from "../src/config.js";
import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";
import { OrderIdentity } from "../src/order-identity.js";
import { OrderMonitor } from "../src/order-monitor.js";
import { OwnerTokenService } from "../src/owner-service.js";
import { TeslaTokenService } from "../src/token-service.js";
import type {
  OwnerGateway,
  TeslaGateway,
  TeslaOrder,
  TeslaRegionResult,
  TeslaTokenResponse,
} from "../src/types.js";

const FLEET_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TEST_ACCESS_TOKEN = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
  JSON.stringify({ scp: ["openid", "offline_access", "user_data", "vehicle_device_data"] }),
).toString("base64url")}.signature`;

class MockTesla implements TeslaGateway {
  expectedNonce: string | null = null;

  buildAuthorizationUrl(input: { state: string; nonce: string }): URL {
    const url = new URL("https://auth.example/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    return url;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    expectedNonce: string;
  }): Promise<{ tokens: TeslaTokenResponse; subject: string | null }> {
    assert.equal(input.code, "test-code");
    this.expectedNonce = input.expectedNonce;
    return {
      tokens: {
        access_token: TEST_ACCESS_TOKEN,
        refresh_token: "test-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
      },
      subject: "subject",
    };
  }

  async getRegion(_accessToken: string): Promise<TeslaRegionResult> {
    return { raw: { response: { region: "NA" } }, fleetBaseUrl: FLEET_BASE_URL };
  }

  async getOrders(_accessToken: string, _fleetBaseUrl: string): Promise<TeslaOrder[]> {
    return [
      {
        referenceNumber: "RN123456789",
        vin: "5YJ12345678901234",
        orderStatus: "BOOKED",
        orderSubstatus: "AWAITING_VIN",
        modelCode: "m3",
        mktOptions: ["PPSW"],
        delivery: { street: "123 Private Road" },
      },
    ];
  }

  async getOrderDetails(
    _accessToken: string,
    referenceNumber: string,
    countryCode?: string,
  ): Promise<unknown> {
    assert.equal(referenceNumber, "RN123456789");
    assert.equal(countryCode, undefined);
    return {
      tasks: {
        scheduling: {
          deliveryWindowDisplay: "August 28 - September 3",
          apptDateTimeAddressStr: "Private delivery appointment",
        },
      },
    };
  }

  async refresh(_refreshToken: string): Promise<TeslaTokenResponse> {
    throw new Error("refresh should not run in this test");
  }
}

class MockOwner implements OwnerGateway {
  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): URL {
    const url = new URL("https://auth.tesla.com/oauth2/v3/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("redirect_uri", "tesla://auth/callback");
    return url;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<TeslaTokenResponse> {
    assert.equal(input.code, "owner-code");
    assert.ok(input.codeVerifier.length >= 43);
    return {
      access_token: "owner-access-token",
      refresh_token: "owner-refresh-token",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid email offline_access",
    };
  }

  async refresh(): Promise<TeslaTokenResponse> {
    throw new Error("refresh should not run in this test");
  }

  async getOrders(): Promise<TeslaOrder[]> {
    return [];
  }

  async getOrderDetails(): Promise<unknown> {
    return { tasks: {} };
  }
}

function testConfig(directory: string, publicKeyFile: string): ServiceConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8787,
    dataDir: directory,
    databasePath: join(directory, "orderpulse.sqlite"),
    publicBaseUrl: "https://orderpulse.baodishan.com",
    redirectUri: "https://orderpulse.baodishan.com/oauth/tesla/callback",
    adminUsername: "orderpulse",
    adminPassword: "a-long-test-password",
    tokenEncryptionKey: randomBytes(32),
    teslaClientId: "client-id",
    teslaClientSecret: "client-secret",
    teslaFleetBaseUrl: FLEET_BASE_URL,
    teslaAuthorizationUrl: "https://auth.example/authorize",
    teslaTokenUrl: "https://auth.example/token",
    teslaOidcIssuer: "https://auth.example",
    teslaJwksUrl: "https://auth.example/jwks",
    teslaScopes: ["openid", "offline_access", "user_data", "vehicle_device_data"],
    teslaPublicKeyFile: publicKeyFile,
    oauthTransactionTtlSeconds: 600,
    ownerAuthorizationTtlSeconds: 3_600,
    requestTimeoutMs: 1_000,
    requireIdToken: false,
    orderPollingEnabled: false,
    orderPollingIntervalSeconds: 1_800,
    orderPollingJitterSeconds: 60,
    orderMissingThreshold: 3,
    mobilePairingTtlSeconds: 600,
    apnsEnabled: false,
    apnsEnvironment: "sandbox",
    apnsKeyId: null,
    apnsTeamId: null,
    apnsTopic: "com.baodishan.orderpulse",
    apnsPrivateKey: null,
  };
}

test("service protects admin routes and completes a one-time OAuth callback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-app-"));
  const publicKeyFile = join(directory, "public-key.pem");
  writeFileSync(publicKeyFile, "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n");
  const config = testConfig(directory, publicKeyFile);
  const database = new OrderPulseDatabase(config.databasePath, new SecretBox(config.tokenEncryptionKey));
  const tesla = new MockTesla();
  const tokenService = new TeslaTokenService(database, tesla);
  const ownerService = new OwnerTokenService(
    database,
    new MockOwner(),
    config.ownerAuthorizationTtlSeconds,
  );
  const orderMonitor = new OrderMonitor({
    database,
    tokenService,
    identity: new OrderIdentity(config.tokenEncryptionKey),
    enabled: false,
    intervalSeconds: config.orderPollingIntervalSeconds,
    jitterSeconds: config.orderPollingJitterSeconds,
    missingThreshold: config.orderMissingThreshold,
  });
  const app = createApp({
    config,
    database,
    tesla,
    tokenService,
    orderMonitor,
    ownerService,
  });
  const authorization = `Basic ${Buffer.from("orderpulse:a-long-test-password").toString("base64")}`;

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);

  const unauthorized = await app.inject({ method: "GET", url: "/api/status" });
  assert.equal(unauthorized.statusCode, 401);
  const unauthorizedState = await app.inject({ method: "GET", url: "/api/order-state" });
  assert.equal(unauthorizedState.statusCode, 401);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const missingCredentials = await app.inject({ method: "GET", url: "/api/status" });
    assert.equal(missingCredentials.statusCode, 401);
  }

  const wrongAuthorization = `Basic ${Buffer.from("orderpulse:wrong-password").toString("base64")}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const wrongCredentials = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: wrongAuthorization },
    });
    assert.equal(wrongCredentials.statusCode, attempt === 10 ? 429 : 401);
  }

  const emptyStatus = await app.inject({
    method: "GET",
    url: "/api/status",
    headers: { authorization },
  });
  assert.equal(emptyStatus.statusCode, 200);
  assert.equal(emptyStatus.json().authorized, false);

  const start = await app.inject({
    method: "GET",
    url: "/oauth/tesla/start",
    headers: { authorization },
  });
  assert.equal(start.statusCode, 302);
  const authorizationUrl = new URL(start.headers.location ?? "");
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);

  const callback = await app.inject({
    method: "GET",
    url: `/oauth/tesla/callback?code=test-code&state=${encodeURIComponent(state)}`,
  });
  assert.equal(callback.statusCode, 200);
  assert.match(callback.body, /OrderPulse 已连接/);
  assert.ok(tesla.expectedNonce);

  const replay = await app.inject({
    method: "GET",
    url: `/oauth/tesla/callback?code=test-code&state=${encodeURIComponent(state)}`,
  });
  assert.equal(replay.statusCode, 400);

  database.updateScopes("");
  const status = await app.inject({ method: "GET", url: "/api/status", headers: { authorization } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().authorized, true);
  assert.deepEqual(status.json().scopes, [
    "openid",
    "offline_access",
    "user_data",
    "vehicle_device_data",
  ]);
  assert.equal(database.loadTeslaTokens()?.scopes, "openid offline_access user_data vehicle_device_data");

  const orders = await app.inject({ method: "GET", url: "/api/orders", headers: { authorization } });
  assert.equal(orders.statusCode, 200);
  assert.doesNotMatch(orders.body, /RN123456789|5YJ12345678901234|123 Private Road/);
  assert.match(orders.body, /BOOKED/);
  assert.match(orders.body, /AWAITING_VIN/);

  const stateResponse = await app.inject({
    method: "GET",
    url: "/api/order-state",
    headers: { authorization },
  });
  assert.equal(stateResponse.statusCode, 200);
  assert.match(stateResponse.body, /AWAITING_VIN/);
  assert.doesNotMatch(stateResponse.body, /RN123456789|5YJ12345678901234|123 Private Road/);

  const events = await app.inject({
    method: "GET",
    url: "/api/events",
    headers: { authorization },
  });
  assert.equal(events.statusCode, 200);
  assert.match(events.body, /baseline_created/);

  const polling = await app.inject({
    method: "GET",
    url: "/api/polling/status",
    headers: { authorization },
  });
  assert.equal(polling.statusCode, 200);
  assert.equal(polling.json().enabled, false);
  assert.equal(polling.json().latestRun.outcome, "success");

  const schema = await app.inject({
    method: "GET",
    url: "/api/orders/schema",
    headers: { authorization },
  });
  assert.equal(schema.statusCode, 200);
  assert.match(schema.body, /delivery\.street/);
  assert.doesNotMatch(schema.body, /123 Private Road/);

  const detailSchema = await app.inject({
    method: "GET",
    url: "/api/order-details/schema",
    headers: { authorization },
  });
  assert.equal(detailSchema.statusCode, 409);
  assert.equal(detailSchema.json().error, "owner_not_authorized");

  const pairingCodeResponse = await app.inject({
    method: "POST",
    url: "/api/devices/pairing-code",
    headers: { authorization },
  });
  assert.equal(pairingCodeResponse.statusCode, 200);
  const pairingCode = pairingCodeResponse.json().code as string;
  assert.match(pairingCode, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

  const paired = await app.inject({
    method: "POST",
    url: "/api/mobile/pair",
    payload: { code: pairingCode.toLowerCase(), name: "Test iPhone" },
  });
  assert.equal(paired.statusCode, 200);
  const mobileAccessToken = paired.json().accessToken as string;
  const mobileDeviceId = paired.json().deviceId as string;
  assert.ok(mobileAccessToken.length >= 32);

  const replayedPairingCode = await app.inject({
    method: "POST",
    url: "/api/mobile/pair",
    payload: { code: pairingCode, name: "Second iPhone" },
  });
  assert.equal(replayedPairingCode.statusCode, 401);

  const mobileAuthorization = `Bearer ${mobileAccessToken}`;
  const bootstrap = await app.inject({
    method: "GET",
    url: "/api/mobile/bootstrap",
    headers: { authorization: mobileAuthorization },
  });
  assert.equal(bootstrap.statusCode, 200);
  assert.match(bootstrap.body, /AWAITING_VIN/);
  assert.doesNotMatch(bootstrap.body, /RN123456789|5YJ12345678901234|123 Private Road/);

  const unauthorizedMobileRefresh = await app.inject({
    method: "POST",
    url: "/api/mobile/refresh",
  });
  assert.equal(unauthorizedMobileRefresh.statusCode, 401);

  const mobileRefresh = await app.inject({
    method: "POST",
    url: "/api/mobile/refresh",
    headers: { authorization: mobileAuthorization },
  });
  assert.equal(mobileRefresh.statusCode, 200);
  assert.equal(mobileRefresh.json().polled, false);
  assert.ok((mobileRefresh.json().retryAfterSeconds as number) > 0);
  assert.match(JSON.stringify(mobileRefresh.json().bootstrap), /AWAITING_VIN/);
  assert.doesNotMatch(mobileRefresh.body, /RN123456789|5YJ12345678901234|123 Private Road/);

  const ownerStart = await app.inject({
    method: "POST",
    url: "/api/mobile/owner-authorization/start",
    headers: { authorization: mobileAuthorization },
  });
  assert.equal(ownerStart.statusCode, 200);
  const ownerAuthorizationUrl = new URL(ownerStart.json().authorizationUrl as string);
  assert.equal(ownerAuthorizationUrl.searchParams.get("redirect_uri"), "tesla://auth/callback");
  const ownerState = ownerAuthorizationUrl.searchParams.get("state");
  assert.ok(ownerState);

  const ownerComplete = await app.inject({
    method: "POST",
    url: "/api/mobile/owner-authorization/complete",
    headers: { authorization: mobileAuthorization },
    payload: {
      callbackUrl: `tesla://auth/callback?code=owner-code&state=${encodeURIComponent(ownerState)}`,
    },
  });
  assert.equal(ownerComplete.statusCode, 204);
  assert.equal(database.hasOwnerTokens(), true);

  const ownerBootstrap = await app.inject({
    method: "GET",
    url: "/api/mobile/bootstrap",
    headers: { authorization: mobileAuthorization },
  });
  assert.equal(ownerBootstrap.json().ownerAuthorized, true);

  const duplicateOwnerStart = await app.inject({
    method: "POST",
    url: "/api/mobile/owner-authorization/start",
    headers: { authorization: mobileAuthorization },
  });
  assert.equal(duplicateOwnerStart.statusCode, 409);

  const pushToken = "ab".repeat(32);
  const registeredPush = await app.inject({
    method: "PUT",
    url: "/api/mobile/device-token",
    headers: { authorization: mobileAuthorization },
    payload: { token: pushToken, environment: "sandbox" },
  });
  assert.equal(registeredPush.statusCode, 204);

  const devices = await app.inject({
    method: "GET",
    url: "/api/devices",
    headers: { authorization },
  });
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.json().devices[0].pushEnabled, true);
  assert.doesNotMatch(devices.body, new RegExp(pushToken));

  const revoked = await app.inject({
    method: "DELETE",
    url: `/api/devices/${mobileDeviceId}`,
    headers: { authorization },
  });
  assert.equal(revoked.statusCode, 204);
  const revokedBootstrap = await app.inject({
    method: "GET",
    url: "/api/mobile/bootstrap",
    headers: { authorization: mobileAuthorization },
  });
  assert.equal(revokedBootstrap.statusCode, 401);

  const publicKey = await app.inject({
    method: "GET",
    url: "/.well-known/appspecific/com.tesla.3p.public-key.pem",
  });
  assert.equal(publicKey.statusCode, 200);
  assert.match(publicKey.headers["content-type"] ?? "", /application\/x-pem-file/);

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/authorization",
    headers: { authorization },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(database.hasTeslaTokens(), false);

  await app.close();
  database.close();
});
