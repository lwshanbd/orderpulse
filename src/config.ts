import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { ApnsEnvironment } from "./mobile-types.js";

const environmentSchema = z.enum(["development", "test", "production"]);

export interface ServiceConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  publicBaseUrl: string;
  redirectUri: string;
  adminUsername: string;
  adminPassword: string;
  tokenEncryptionKey: Buffer;
  teslaClientId: string;
  teslaClientSecret: string;
  teslaFleetBaseUrl: string;
  teslaAuthorizationUrl: string;
  teslaTokenUrl: string;
  teslaOidcIssuer: string;
  teslaJwksUrl: string;
  teslaScopes: string[];
  teslaPublicKeyFile: string;
  oauthTransactionTtlSeconds: number;
  ownerAuthorizationTtlSeconds: number;
  requestTimeoutMs: number;
  requireIdToken: boolean;
  orderPollingEnabled: boolean;
  orderPollingIntervalSeconds: number;
  orderPollingJitterSeconds: number;
  orderMissingThreshold: number;
  mobilePairingTtlSeconds: number;
  apnsEnabled: boolean;
  apnsEnvironment: ApnsEnvironment;
  apnsKeyId: string | null;
  apnsTeamId: string | null;
  apnsTopic: string;
  apnsPrivateKey: string | null;
}

function readConfiguredValue(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { secret?: boolean; production?: boolean } = {},
): string {
  const directValue = env[name]?.trim();
  const filePath = env[`${name}_FILE`]?.trim();

  if (directValue && filePath) {
    throw new Error(`Configure only one of ${name} or ${name}_FILE`);
  }

  if (filePath) {
    const value = readFileSync(filePath, "utf8").trim();
    if (!value) {
      throw new Error(`${name}_FILE points to an empty file`);
    }
    return value;
  }

  if (directValue) {
    if (options.secret && options.production) {
      throw new Error(`${name} must be supplied through ${name}_FILE in production`);
    }
    return directValue;
  }

  throw new Error(`Missing required configuration: ${name} or ${name}_FILE`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected a boolean value, received: ${value}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const nodeEnv = environmentSchema.parse(env.NODE_ENV ?? "development");
  const production = nodeEnv === "production";
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  const port = parsePositiveInteger(env.PORT, 8787, "PORT");
  if (port > 65_535) throw new Error("PORT must not exceed 65535");
  const orderPollingEnabled = parseBoolean(env.ORDER_POLLING_ENABLED, false);
  const orderPollingIntervalSeconds = parsePositiveInteger(
    env.ORDER_POLL_INTERVAL_SECONDS,
    1_800,
    "ORDER_POLL_INTERVAL_SECONDS",
  );
  if (production && orderPollingEnabled && orderPollingIntervalSeconds < 300) {
    throw new Error("ORDER_POLL_INTERVAL_SECONDS must be at least 300 in production");
  }
  if (orderPollingIntervalSeconds > 86_400) {
    throw new Error("ORDER_POLL_INTERVAL_SECONDS must not exceed 86400");
  }
  const orderPollingJitterSeconds = parseNonNegativeInteger(
    env.ORDER_POLL_JITTER_SECONDS,
    60,
    "ORDER_POLL_JITTER_SECONDS",
  );
  if (orderPollingJitterSeconds > 3_600) {
    throw new Error("ORDER_POLL_JITTER_SECONDS must not exceed 3600");
  }
  const orderMissingThreshold = parsePositiveInteger(
    env.ORDER_MISSING_THRESHOLD,
    3,
    "ORDER_MISSING_THRESHOLD",
  );
  if (orderMissingThreshold > 100) {
    throw new Error("ORDER_MISSING_THRESHOLD must not exceed 100");
  }
  const mobilePairingTtlSeconds = parsePositiveInteger(
    env.MOBILE_PAIRING_TTL_SECONDS,
    3_600,
    "MOBILE_PAIRING_TTL_SECONDS",
  );
  if (mobilePairingTtlSeconds > 3_600) {
    throw new Error("MOBILE_PAIRING_TTL_SECONDS must not exceed 3600");
  }
  const ownerAuthorizationTtlSeconds = parsePositiveInteger(
    env.OWNER_AUTHORIZATION_TTL_SECONDS,
    3_600,
    "OWNER_AUTHORIZATION_TTL_SECONDS",
  );
  if (ownerAuthorizationTtlSeconds > 3_600) {
    throw new Error("OWNER_AUTHORIZATION_TTL_SECONDS must not exceed 3600");
  }

  const apnsEnabled = parseBoolean(env.APNS_ENABLED, false);
  const apnsEnvironment = z
    .enum(["sandbox", "production"])
    .parse(env.APNS_ENVIRONMENT ?? "sandbox");
  const apnsTopic = env.APNS_TOPIC?.trim() || "com.baodishan.orderpulse";
  if (!/^[A-Za-z0-9.-]+$/.test(apnsTopic)) {
    throw new Error("APNS_TOPIC must be a valid bundle identifier");
  }
  const apnsKeyId = apnsEnabled
    ? readConfiguredValue(env, "APNS_KEY_ID", { production })
    : null;
  const apnsTeamId = apnsEnabled
    ? readConfiguredValue(env, "APNS_TEAM_ID", { production })
    : null;
  const apnsPrivateKey = apnsEnabled
    ? readConfiguredValue(env, "APNS_PRIVATE_KEY", { secret: true, production })
    : null;

  const publicUrl = new URL(env.PUBLIC_BASE_URL ?? "https://orderpulse.baodishan.com");
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_BASE_URL must be an origin without a path, query, or fragment");
  }
  if (production && publicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }

  const adminPassword = readConfiguredValue(env, "ADMIN_PASSWORD", {
    secret: true,
    production,
  });
  if (adminPassword.length < 16) {
    throw new Error("ADMIN_PASSWORD must contain at least 16 characters");
  }

  const encodedEncryptionKey = readConfiguredValue(env, "TOKEN_ENCRYPTION_KEY", {
    secret: true,
    production,
  });
  const tokenEncryptionKey = Buffer.from(encodedEncryptionKey, "base64");
  if (tokenEncryptionKey.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64");
  }

  const scopeString =
    env.TESLA_SCOPES?.trim() || "openid offline_access user_data vehicle_device_data";
  const teslaScopes = [...new Set(scopeString.split(/\s+/).filter(Boolean))];
  const allowedScopes = new Set([
    "openid",
    "offline_access",
    "user_data",
    "vehicle_device_data",
  ]);
  const unexpectedScope = teslaScopes.find((scope) => !allowedScopes.has(scope));
  if (unexpectedScope) {
    throw new Error(`TESLA_SCOPES contains an unnecessary or unsupported scope: ${unexpectedScope}`);
  }
  for (const requiredScope of allowedScopes) {
    if (!teslaScopes.includes(requiredScope)) {
      throw new Error(`TESLA_SCOPES must include ${requiredScope}`);
    }
  }

  return {
    nodeEnv,
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    dataDir,
    databasePath: resolve(dataDir, "orderpulse.sqlite"),
    publicBaseUrl: publicUrl.origin,
    redirectUri: new URL("/oauth/tesla/callback", publicUrl).toString(),
    adminUsername: env.ADMIN_USERNAME?.trim() || "orderpulse",
    adminPassword,
    tokenEncryptionKey,
    teslaClientId: readConfiguredValue(env, "TESLA_CLIENT_ID", { production }),
    teslaClientSecret: readConfiguredValue(env, "TESLA_CLIENT_SECRET", {
      secret: true,
      production,
    }),
    teslaFleetBaseUrl:
      env.TESLA_FLEET_BASE_URL?.trim() || "https://fleet-api.prd.na.vn.cloud.tesla.com",
    teslaAuthorizationUrl:
      env.TESLA_AUTHORIZATION_URL?.trim() || "https://auth.tesla.com/oauth2/v3/authorize",
    teslaTokenUrl:
      env.TESLA_TOKEN_URL?.trim() ||
      "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token",
    teslaOidcIssuer:
      env.TESLA_OIDC_ISSUER?.trim() || "https://auth.tesla.com/oauth2/v3/nts",
    teslaJwksUrl:
      env.TESLA_JWKS_URL?.trim() ||
      "https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys",
    teslaScopes,
    teslaPublicKeyFile: resolve(
      env.TESLA_PUBLIC_KEY_FILE ??
        "./public/.well-known/appspecific/com.tesla.3p.public-key.pem",
    ),
    oauthTransactionTtlSeconds: parsePositiveInteger(
      env.OAUTH_TRANSACTION_TTL_SECONDS,
      600,
      "OAUTH_TRANSACTION_TTL_SECONDS",
    ),
    ownerAuthorizationTtlSeconds,
    requestTimeoutMs: parsePositiveInteger(env.REQUEST_TIMEOUT_MS, 10_000, "REQUEST_TIMEOUT_MS"),
    requireIdToken: parseBoolean(env.TESLA_REQUIRE_ID_TOKEN, true),
    orderPollingEnabled,
    orderPollingIntervalSeconds,
    orderPollingJitterSeconds,
    orderMissingThreshold,
    mobilePairingTtlSeconds,
    apnsEnabled,
    apnsEnvironment,
    apnsKeyId,
    apnsTeamId,
    apnsTopic,
    apnsPrivateKey,
  };
}
