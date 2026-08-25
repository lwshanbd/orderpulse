import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";
import { TeslaRequestError } from "../src/tesla.js";
import { TeslaTokenService } from "../src/token-service.js";
import type {
  TeslaGateway,
  TeslaOrder,
  TeslaRegionResult,
  TeslaTokenResponse,
} from "../src/types.js";

const FLEET_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";

class RefreshingTesla implements TeslaGateway {
  refreshCalls = 0;
  regionCalls = 0;

  buildAuthorizationUrl(_input: { state: string; nonce: string }): URL {
    return new URL("https://example.com");
  }

  async exchangeAuthorizationCode(_input: {
    code: string;
    expectedNonce: string;
  }): Promise<{ tokens: TeslaTokenResponse; subject: string | null }> {
    throw new Error("not used");
  }

  async getRegion(_accessToken: string): Promise<TeslaRegionResult> {
    this.regionCalls += 1;
    return { raw: {}, fleetBaseUrl: FLEET_BASE_URL };
  }

  async getOrders(accessToken: string, _fleetBaseUrl: string): Promise<TeslaOrder[]> {
    assert.equal(accessToken, "new-access");
    return [];
  }

  async getOrderDetails(): Promise<unknown> {
    throw new Error("not used");
  }

  async refresh(refreshToken: string): Promise<TeslaTokenResponse> {
    assert.equal(refreshToken, "old-refresh");
    this.refreshCalls += 1;
    await Promise.resolve();
    return {
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: 3_600,
    };
  }
}

test("concurrent requests share one refresh and persist the rotated refresh token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-refresh-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );
  database.saveTeslaTokens({
    tokens: {
      access_token: "expired-access",
      refresh_token: "old-refresh",
      token_type: "Bearer",
      expires_in: 0,
      scope: "openid offline_access user_data vehicle_device_data",
    },
    fleetBaseUrl: FLEET_BASE_URL,
    subject: "subject",
  });

  const tesla = new RefreshingTesla();
  const service = new TeslaTokenService(database, tesla);
  await Promise.all([service.getOrders(), service.getOrders()]);

  assert.equal(tesla.refreshCalls, 1);
  assert.equal(tesla.regionCalls, 0);
  assert.equal(database.loadTeslaTokens()?.refreshToken, "new-refresh");
  assert.equal(database.loadTeslaTokens()?.accessToken, "new-access");
  database.close();
});

test("an early 401 refreshes once and retries without a routine region request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-early-401-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );
  database.saveTeslaTokens({
    tokens: {
      access_token: "rejected-access",
      refresh_token: "old-refresh",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid offline_access user_data vehicle_device_data",
    },
    fleetBaseUrl: FLEET_BASE_URL,
    subject: "subject",
  });

  let orderCalls = 0;
  let refreshCalls = 0;
  let regionCalls = 0;
  const tesla: TeslaGateway = {
    buildAuthorizationUrl: () => new URL("https://example.com"),
    async exchangeAuthorizationCode() {
      throw new Error("not used");
    },
    async getRegion() {
      regionCalls += 1;
      return { raw: {}, fleetBaseUrl: FLEET_BASE_URL };
    },
    async getOrders(accessToken) {
      orderCalls += 1;
      if (accessToken === "rejected-access") {
        throw new TeslaRequestError({ message: "expired", status: 401 });
      }
      assert.equal(accessToken, "new-access");
      return [];
    },
    async getOrderDetails() {
      throw new Error("not used");
    },
    async refresh(refreshToken) {
      assert.equal(refreshToken, "old-refresh");
      refreshCalls += 1;
      return {
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 3_600,
      };
    },
  };

  const service = new TeslaTokenService(database, tesla);
  await service.getOrders();
  assert.equal(orderCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(regionCalls, 0);
  assert.equal(database.loadTeslaTokens()?.refreshToken, "new-refresh");
  database.close();
});
