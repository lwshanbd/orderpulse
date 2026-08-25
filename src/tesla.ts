import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ServiceConfig } from "./config.js";
import type {
  TeslaGateway,
  TeslaOrder,
  TeslaRegionResult,
  TeslaTokenResponse,
} from "./types.js";

const ALLOWED_FLEET_BASE_URLS = new Set([
  "https://fleet-api.prd.na.vn.cloud.tesla.com",
  "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
]);

const REGION_BASE_URLS: Record<string, string> = {
  NA: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  NORTH_AMERICA: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  US: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  CA: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  APAC: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  EU: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  EMEA: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  CN: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
  CHINA: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
};

export class TeslaRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly transactionId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    message: string;
    status: number;
    code?: string | null;
    transactionId?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(input.message);
    this.name = "TeslaRequestError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.transactionId = input.transactionId ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  const seconds = Math.ceil((retryAt - Date.now()) / 1_000);
  return seconds > 0 ? seconds : null;
}

function assertTokenResponse(value: unknown): TeslaTokenResponse {
  if (!isRecord(value)) throw new Error("Tesla returned an invalid token response");
  if (
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.token_type !== "string" ||
    value.token_type.length === 0 ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new Error("Tesla token response is missing required fields");
  }
  return value as unknown as TeslaTokenResponse;
}

function findFleetBaseUrl(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.replace(/\/$/, "");
    return ALLOWED_FLEET_BASE_URLS.has(normalized) ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFleetBaseUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  for (const [key, item] of Object.entries(value)) {
    if (/region/i.test(key) && typeof item === "string") {
      const mapped = REGION_BASE_URLS[item.toUpperCase()];
      if (mapped) return mapped;
    }
    const found = findFleetBaseUrl(item);
    if (found) return found;
  }
  return null;
}

export function normalizeFleetBaseUrl(value: string): string {
  const normalized = value.replace(/\/$/, "");
  if (!ALLOWED_FLEET_BASE_URLS.has(normalized)) {
    throw new Error("Refusing to call an unrecognized Fleet API base URL");
  }
  return normalized;
}

export class TeslaClient implements TeslaGateway {
  readonly #config: ServiceConfig;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ServiceConfig) {
    this.#config = config;
    this.#jwks = createRemoteJWKSet(new URL(config.teslaJwksUrl));
  }

  buildAuthorizationUrl(input: { state: string; nonce: string }): URL {
    const url = new URL(this.#config.teslaAuthorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#config.teslaClientId);
    url.searchParams.set("redirect_uri", this.#config.redirectUri);
    url.searchParams.set("scope", this.#config.teslaScopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("prompt_missing_scopes", "true");
    url.searchParams.set("require_requested_scopes", "true");
    return url;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    expectedNonce: string;
  }): Promise<{ tokens: TeslaTokenResponse; subject: string | null }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.#config.teslaClientId,
      client_secret: this.#config.teslaClientSecret,
      code: input.code,
      audience: this.#config.teslaFleetBaseUrl,
      redirect_uri: this.#config.redirectUri,
      scope: this.#config.teslaScopes.join(" "),
    });
    const raw = await this.#requestToken(body);
    const tokens = assertTokenResponse(raw);

    if (!tokens.id_token) {
      if (this.#config.requireIdToken) {
        throw new Error("Tesla did not return the required OpenID Connect ID token");
      }
      return { tokens, subject: null };
    }

    const verified = await jwtVerify(tokens.id_token, this.#jwks, {
      issuer: this.#config.teslaOidcIssuer,
      audience: this.#config.teslaClientId,
    });
    if (verified.payload.nonce !== input.expectedNonce) {
      throw new Error("Tesla ID token nonce did not match the OAuth transaction");
    }

    return { tokens, subject: verified.payload.sub ?? null };
  }

  async refresh(refreshToken: string): Promise<TeslaTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.#config.teslaClientId,
      refresh_token: refreshToken,
    });
    return assertTokenResponse(await this.#requestToken(body));
  }

  async getRegion(accessToken: string): Promise<TeslaRegionResult> {
    const raw = await this.#fleetRequest(
      this.#config.teslaFleetBaseUrl,
      "/api/1/users/region",
      accessToken,
    );
    return {
      raw,
      fleetBaseUrl: findFleetBaseUrl(raw) ?? normalizeFleetBaseUrl(this.#config.teslaFleetBaseUrl),
    };
  }

  async getOrders(accessToken: string, fleetBaseUrl: string): Promise<TeslaOrder[]> {
    const raw = await this.#fleetRequest(
      normalizeFleetBaseUrl(fleetBaseUrl),
      "/api/1/users/orders",
      accessToken,
    );
    if (!isRecord(raw) || !Array.isArray(raw.response)) {
      throw new Error("Tesla returned an invalid orders response");
    }
    return raw.response.filter(isRecord) as TeslaOrder[];
  }

  async #requestToken(body: URLSearchParams): Promise<unknown> {
    const response = await fetch(this.#config.teslaTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
    });
    return this.#parseResponse(response);
  }

  async #fleetRequest(baseUrl: string, path: string, accessToken: string): Promise<unknown> {
    const response = await fetch(new URL(path, `${baseUrl}/`), {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
    });
    return this.#parseResponse(response);
  }

  async #parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const body = isRecord(parsed) ? parsed : {};
      const code = typeof body.error === "string" ? body.error : null;
      const description =
        typeof body.error_description === "string" ? body.error_description : null;
      const transactionId =
        response.headers.get("x-txid") ??
        (typeof body.txid === "string" ? body.txid : null);
      throw new TeslaRequestError({
        message: description || code || `Tesla request failed with HTTP ${response.status}`,
        status: response.status,
        code,
        transactionId,
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
      });
    }
    return parsed;
  }
}
