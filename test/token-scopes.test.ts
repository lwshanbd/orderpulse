import assert from "node:assert/strict";
import test from "node:test";

import { accessTokenScopes, grantedScopes } from "../src/token-scopes.js";
import type { TeslaTokenResponse } from "../src/types.js";

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${claims}.signature`;
}

function tokens(accessToken: string, scope?: string): TeslaTokenResponse {
  return {
    access_token: accessToken,
    refresh_token: "refresh",
    token_type: "Bearer",
    expires_in: 3_600,
    ...(scope === undefined ? {} : { scope }),
  };
}

test("reads granted scopes from Tesla access token scp claim", () => {
  const accessToken = unsignedJwt({
    scp: ["openid", "offline_access", "user_data", "vehicle_device_data"],
  });
  assert.equal(
    grantedScopes(tokens(accessToken)),
    "openid offline_access user_data vehicle_device_data",
  );
  assert.deepEqual(accessTokenScopes(accessToken), [
    "openid",
    "offline_access",
    "user_data",
    "vehicle_device_data",
  ]);
});

test("prefers token response scope and falls back for opaque access tokens", () => {
  assert.equal(grantedScopes(tokens("opaque", "openid user_data")), "openid user_data");
  assert.equal(
    grantedScopes(tokens("opaque"), "openid offline_access user_data"),
    "openid offline_access user_data",
  );
});
