import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";
import {
  extractOrderDeliveryDetails,
  ownerCodeChallenge,
  OwnerTeslaClient,
  type OwnerTokenRequestInput,
} from "../src/owner-api.js";
import { OwnerTokenService, PreferredOrderProvider } from "../src/owner-service.js";
import { TeslaRequestError } from "../src/tesla.js";
import type {
  OwnerGateway,
  TeslaOrder,
  TeslaTokenResponse,
} from "../src/types.js";

class FakeOwner implements OwnerGateway {
  state: string | null = null;
  codeChallenge: string | null = null;
  exchangedVerifier: string | null = null;

  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): URL {
    this.state = input.state;
    this.codeChallenge = input.codeChallenge;
    const url = new URL("https://auth.tesla.com/oauth2/v3/authorize");
    url.searchParams.set("state", input.state);
    return url;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<TeslaTokenResponse> {
    assert.equal(input.code, "owner-code");
    this.exchangedVerifier = input.codeVerifier;
    return {
      access_token: "owner-access",
      refresh_token: "owner-refresh",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid email offline_access",
    };
  }

  async refresh(): Promise<TeslaTokenResponse> {
    throw new Error("not used");
  }

  async getOrders(): Promise<TeslaOrder[]> {
    throw new Error("legacy Owner orders endpoint must not be used");
  }

  async getOrderDetails(
    _accessToken: string,
    referenceNumber: string,
    countryCode?: string,
  ): Promise<unknown> {
    assert.equal(referenceNumber, "RN123456789");
    assert.equal(countryCode, "US");
    return {
      tasks: {
        financing: {
          id: "financing",
          complete: true,
          enabled: true,
          required: true,
          order: 1,
          card: { title: "Financing" },
        },
        scheduling: {
          id: "scheduling",
          complete: false,
          enabled: true,
          required: true,
          order: 2,
          card: { title: "Schedule delivery" },
          deliveryWindowDisplay: "September 13 - September 30",
          deliveryAppointmentDate: "2026-09-20T14:00:00-04:00",
          appointmentStatusName: "SCHEDULED",
          isValidAppointment: true,
          isEligibleForReschedule: true,
          isDeliveryEstimatesEnabled: true,
          deliveryType: "PICKUP_SERVICE_CENTER",
          deliveryAddressTitle: "Smithtown",
        },
        finalPayment: { data: { etaToDeliveryCenter: "2026-09-10T00:00:00Z" } },
        isDeliveryAgentAssigned: true,
      },
    };
  }
}

test("Owner PKCE authorization is one-time and enriches orders without exposing identifiers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-owner-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );
  const gateway = new FakeOwner();
  const service = new OwnerTokenService(database, gateway, 600);

  service.beginAuthorization();
  assert.ok(gateway.state?.startsWith("owner_"));
  assert.ok(gateway.codeChallenge);
  await service.completeAuthorization(
    `tesla://auth/callback?code=owner-code&state=${encodeURIComponent(gateway.state ?? "")}`,
  );
  assert.equal(ownerCodeChallenge(gateway.exchangedVerifier ?? ""), gateway.codeChallenge);
  assert.equal(service.authorized, true);

  const provider = new PreferredOrderProvider(service, {
    async getOrders(): Promise<TeslaOrder[]> {
      return [{
        referenceNumber: "RN123456789",
        orderStatus: "BOOKED",
        modelCode: "MY",
        vin: "7SAYGDEE9NF123456",
        countryCode: "US",
      }];
    },
  });
  const orders = await provider.getOrders();
  const delivery = orders[0]?.orderPulseDelivery;
  assert.equal(delivery?.deliveryWindow, "September 13 - September 30");
  assert.equal(delivery?.appointment, "2026-09-20T14:00:00-04:00");
  assert.equal(delivery?.appointmentStatus, "SCHEDULED");
  assert.equal(delivery?.appointmentValid, true);
  assert.equal(delivery?.rescheduleEligible, true);
  assert.equal(delivery?.deliveryEstimatesEnabled, true);
  assert.equal(delivery?.deliveryCenter, "Smithtown");
  assert.equal(delivery?.financingComplete, true);
  assert.equal(delivery?.pendingTaskCount, 1);
  assert.equal(delivery?.vin, "•••••••••••123456");
  assert.doesNotMatch(JSON.stringify(delivery), /7SAYGDEE9NF123456|RN123456789/);

  await assert.rejects(
    () => service.completeAuthorization(
      `https://auth.tesla.com/void/callback?code=owner-code&state=${encodeURIComponent(gateway.state ?? "")}`,
    ),
    /not from Tesla/,
  );
  await assert.rejects(
    () => service.completeAuthorization(
      `tesla://auth/callback?code=owner-code&state=${encodeURIComponent(gateway.state ?? "")}`,
    ),
    /already used/,
  );
  database.close();
});

test("official Fleet orders survive an unavailable Owner delivery endpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-owner-fallback-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );
  const gateway = new FakeOwner();
  gateway.getOrderDetails = async () => {
    throw new TeslaRequestError({ status: 403, message: "forbidden" });
  };
  const service = new OwnerTokenService(database, gateway, 600);
  const stateUrl = service.beginAuthorization();
  await service.completeAuthorization(
    `tesla://auth/callback?code=owner-code&state=${encodeURIComponent(stateUrl.searchParams.get("state") ?? "")}`,
  );
  const fleetOrder: TeslaOrder = {
    referenceNumber: "RN123456789",
    orderStatus: "BOOKED",
    modelCode: "MY",
    countryCode: "US",
  };
  const provider = new PreferredOrderProvider(service, {
    async getOrders(): Promise<TeslaOrder[]> { return [fleetOrder]; },
  });

  assert.deepEqual(await provider.getOrders(), [fleetOrder]);
  database.close();
});

test("an expired Owner token refreshes before enriching Fleet orders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-owner-refresh-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );
  const gateway = new FakeOwner();
  let refreshCount = 0;
  gateway.refresh = async () => {
    refreshCount += 1;
    return {
      access_token: "refreshed-owner-access",
      refresh_token: "rotated-owner-refresh",
      token_type: "Bearer",
      expires_in: 28_800,
      scope: "openid email offline_access",
    };
  };
  gateway.getOrderDetails = async (accessToken, referenceNumber) => {
    assert.equal(accessToken, "refreshed-owner-access");
    assert.equal(referenceNumber, "RN123456789");
    return { tasks: {} };
  };
  database.saveOwnerTokens({
    tokens: {
      access_token: "expired-owner-access",
      refresh_token: "owner-refresh",
      token_type: "Bearer",
      expires_in: -1,
    },
  });
  const provider = new PreferredOrderProvider(
    new OwnerTokenService(database, gateway, 600),
    {
      async getOrders(): Promise<TeslaOrder[]> {
        return [{ referenceNumber: "RN123456789", countryCode: "US" }];
      },
    },
  );

  const orders = await provider.getOrders();
  assert.equal(refreshCount, 1);
  assert.equal(orders[0]?.orderPulseDelivery?.totalTaskCount, 0);
  assert.equal(database.loadOwnerTokens()?.accessToken, "refreshed-owner-access");
  assert.equal(database.loadOwnerTokens()?.refreshToken, "rotated-owner-refresh");
  database.close();
});

test("delivery extraction keeps only a small task summary allowlist", () => {
  const delivery = extractOrderDeliveryDetails(
    { referenceNumber: "RN1" },
    {
      strings: { vin: "7SAYGDEE9NF123456" },
      tasks: {
        fin: {
          id: "fin",
          isComplete: true,
          isEnabled: true,
          isRequired: true,
          order: 1,
          strings: { taskTitle: "Financing" },
        },
        scheduling: {
          id: "scheduling",
          complete: false,
          enabled: true,
          required: true,
          order: 5,
          target: "https://private.example/account",
          card: {
            title: "Schedule delivery",
            messageBody: "private free-form message",
          },
          deliveryWindowDisplay: "September 13 - September 30",
          deliveryAppointmentDate: "2026-09-20T14:00:00-04:00",
          appointmentStatusName: "SCHEDULED",
          isValidAppointment: true,
          isEligibleForReschedule: false,
          isDeliveryEstimatesEnabled: true,
          strings: {
            apptDateTimeStringRange: "September 20, 2:00–3:00 PM",
            deliveryAppointmentScheduled: "Delivery appointment scheduled",
          },
        },
      },
    },
  );
  const serialized = JSON.stringify(delivery);
  assert.equal(delivery.vin, "•••••••••••123456");
  assert.equal(delivery.appointment, "2026-09-20T14:00:00-04:00");
  assert.equal(delivery.appointmentStatus, "SCHEDULED");
  assert.equal(delivery.appointmentValid, true);
  assert.equal(delivery.rescheduleEligible, false);
  assert.equal(delivery.deliveryEstimatesEnabled, true);
  assert.equal(delivery.financingComplete, true);
  assert.deepEqual(delivery.tasks.map((task) => task.title), ["Financing", "Schedule delivery"]);
  assert.match(serialized, /Schedule delivery|September 13/);
  assert.doesNotMatch(serialized, /private free-form message|private\.example|7SAYGDEE9NF123456/);
  assert.doesNotMatch(serialized, /Delivery appointment scheduled/);
});

test("delivery extraction rejects Tesla template placeholders", () => {
  const delivery = extractOrderDeliveryDetails(
    { referenceNumber: "RN1" },
    {
      strings: { vin: "#####vin###" },
      tasks: {
        scheduling: {
          deliveryAppointmentDate: "##date## between ##startTime## - ##endTime##",
          strings: { apptDateTimeStringRange: "##dateRange##" },
          isValidAppointment: false,
          isEligibleForReschedule: false,
        },
      },
    },
  );

  assert.equal(delivery.vin, null);
  assert.equal(delivery.vinAssigned, false);
  assert.equal(delivery.appointment, null);
  assert.doesNotMatch(JSON.stringify(delivery), /#vin|#date|#startTime|#endTime/);
});

test("Owner client separates HTTP/2 token requests from the detail transport", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const tokenRequests: OwnerTokenRequestInput[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: input.toString(), init });
    return new Response(JSON.stringify({ tasks: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const fakeTokenRequest = async (input: OwnerTokenRequestInput) => {
    tokenRequests.push(input);
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3_600,
      }),
    };
  };
  const client = new OwnerTeslaClient(1_000, fakeFetch, fakeTokenRequest);
  const authorizationUrl = client.buildAuthorizationUrl({
    state: "state",
    codeChallenge: "challenge",
  });
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "tesla://auth/callback");

  await client.exchangeAuthorizationCode({ code: "one-time-code", codeVerifier: "verifier" });
  await client.refresh("refresh-token");
  await client.getOrderDetails("access", "RN1234", "us");

  assert.equal(tokenRequests[0]?.url.toString(), "https://auth.tesla.com/oauth2/v3/token");
  assert.equal(
    new Headers(tokenRequests[0]?.headers).get("content-type"),
    "application/x-www-form-urlencoded",
  );
  const tokenBody = new URLSearchParams(tokenRequests[0]?.body);
  assert.equal(tokenBody.get("client_id"), "ownerapi");
  assert.equal(tokenBody.get("code_verifier"), "verifier");
  const refreshBody = new URLSearchParams(tokenRequests[1]?.body);
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "refresh-token");
  assert.equal(requests.length, 1);

  const detailUrl = new URL(requests[0]?.url ?? "https://invalid");
  assert.equal(detailUrl.origin, "https://akamai-apigateway-vfx.tesla.com");
  assert.equal(detailUrl.pathname, "/tasks");
  assert.equal(detailUrl.searchParams.get("referenceNumber"), "RN1234");
  assert.equal(detailUrl.searchParams.get("deviceCountry"), "US");
});
