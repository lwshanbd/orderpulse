import { createHash } from "node:crypto";

import type {
  OrderDeliveryDetails,
  OrderTaskSummary,
  OwnerGateway,
  TeslaOrder,
  TeslaTokenResponse,
} from "./types.js";
import { TeslaRequestError } from "./tesla.js";

const OWNER_CLIENT_ID = "ownerapi";
const OWNER_REDIRECT_URI = "tesla://auth/callback";
const OWNER_AUTHORIZATION_URL = "https://auth.tesla.com/oauth2/v3/authorize";
const OWNER_TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token";
const OWNER_ORDERS_URL = "https://owner-api.teslamotors.com/api/1/users/orders";
const OWNER_DETAILS_URL = "https://akamai-apigateway-vfx.tesla.com/tasks";

interface OwnerHttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

function headerValue(headers: Headers, name: string): string | null {
  return headers.get(name);
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > 5_000_000) {
      await reader.cancel();
      throw new Error("Tesla owner response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function findFirstKey(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      const found = findFirstKey(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) return item;
  }
  for (const item of Object.values(value)) {
    const found = findFirstKey(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function maskedIdentifier(value: unknown, visibleCharacters: number): string | null {
  const text = stringValue(value, 1_024);
  if (!text) return null;
  if (text.length <= visibleCharacters) return "•".repeat(text.length);
  return `${"•".repeat(Math.min(text.length - visibleCharacters, 12))}${text.slice(-visibleCharacters)}`;
}

function taskSummaries(raw: unknown): OrderTaskSummary[] {
  const tasks = atPath(raw, ["tasks"]);
  if (!isRecord(tasks)) return [];
  return Object.entries(tasks)
    .flatMap(([fallbackId, item]): OrderTaskSummary[] => {
      if (!isRecord(item)) return [];
      const id = stringValue(item.id, 100) ?? fallbackId.slice(0, 100);
      const complete =
        booleanValue(item.complete) ??
        booleanValue(item.completed) ??
        booleanValue(item.isComplete);
      const enabled = booleanValue(item.enabled) ?? booleanValue(item.isEnabled);
      if (complete === null || enabled === null) return [];
      const card = isRecord(item.card) ? item.card : null;
      const strings = isRecord(item.strings) ? item.strings : null;
      const title =
        stringValue(card?.title, 160) ??
        stringValue(strings?.title, 160) ??
        stringValue(strings?.name, 160) ??
        stringValue(strings?.taskTitle, 160) ??
        stringValue(strings?.taskName, 160) ??
        id;
      return [{
        id,
        title,
        complete,
        enabled,
        required: booleanValue(item.required) ?? booleanValue(item.isRequired) ?? false,
        order: numberValue(item.order),
      }];
    })
    .sort((left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
    )
    .slice(0, 64);
}

function financingComplete(raw: unknown): boolean | null {
  const tasks = atPath(raw, ["tasks"]);
  if (!isRecord(tasks)) return null;
  for (const [key, item] of Object.entries(tasks)) {
    if (!/(^fin$|financ|payment)/i.test(key) || !isRecord(item)) continue;
    const complete =
      booleanValue(item.complete) ??
      booleanValue(item.completed) ??
      booleanValue(item.isComplete);
    if (complete !== null) return complete;
  }
  return null;
}

export function extractOrderDeliveryDetails(
  order: TeslaOrder,
  raw: unknown,
): OrderDeliveryDetails {
  const tasks = taskSummaries(raw);
  const rawVin =
    stringValue(order.vin, 1_024) ??
    stringValue(atPath(raw, ["strings", "vin"]), 1_024) ??
    stringValue(atPath(raw, ["tasks", "registration", "orderDetails", "vin"]), 1_024);
  const vin = maskedIdentifier(rawVin, 6);
  const routingLocation =
    stringValue(atPath(raw, ["tasks", "registration", "orderDetails", "vehicleRoutingLocation"])) ??
    stringValue(atPath(raw, ["tasks", "transit", "currentLocation"]));
  const plate =
    atPath(raw, ["tasks", "deliveryDetails", "regData", "reggieLicensePlate"]) ??
    atPath(raw, ["tasks", "registration", "plateNumber"]);
  const agentAssigned = findFirstKey(
    raw,
    new Set(["isDeliveryAgentAssigned", "deliveryAgentAssigned", "isTeslaAssistEnabled"]),
  );

  return {
    vin,
    vinAssigned: vin !== null,
    deliveryWindow: stringValue(atPath(raw, ["tasks", "scheduling", "deliveryWindowDisplay"])),
    appointment:
      stringValue(atPath(raw, ["tasks", "scheduling", "deliveryAppointmentDate"]), 1_024) ??
      stringValue(atPath(raw, ["tasks", "scheduling", "strings", "apptDateTimeStringRange"]), 1_024) ??
      stringValue(atPath(raw, ["tasks", "scheduling", "apptDateTimeAddressStr"]), 1_024),
    appointmentStatus: stringValue(
      atPath(raw, ["tasks", "scheduling", "appointmentStatusName"]),
      256,
    ),
    appointmentValid: booleanValue(
      atPath(raw, ["tasks", "scheduling", "isValidAppointment"]),
    ),
    rescheduleEligible: booleanValue(
      atPath(raw, ["tasks", "scheduling", "isEligibleForReschedule"]),
    ),
    deliveryEstimatesEnabled: booleanValue(
      atPath(raw, ["tasks", "scheduling", "isDeliveryEstimatesEnabled"]),
    ),
    etaToDeliveryCenter: stringValue(atPath(raw, ["tasks", "finalPayment", "data", "etaToDeliveryCenter"])),
    vehicleLocation: routingLocation,
    deliveryMethod:
      stringValue(atPath(raw, ["tasks", "scheduling", "deliveryType"])) ??
      stringValue(atPath(raw, ["tasks", "scheduling", "deliveryMethod"])),
    deliveryCenter: stringValue(atPath(raw, ["tasks", "scheduling", "deliveryAddressTitle"])),
    odometer: numberValue(atPath(raw, ["tasks", "registration", "orderDetails", "vehicleOdometer"])),
    odometerUnit: stringValue(atPath(raw, ["tasks", "registration", "orderDetails", "vehicleOdometerType"]), 32),
    reservationDate: stringValue(atPath(raw, ["tasks", "registration", "orderDetails", "reservationDate"])),
    orderBookedDate: stringValue(atPath(raw, ["tasks", "registration", "orderDetails", "orderBookedDate"])),
    licensePlate: maskedIdentifier(plate, 3),
    financingComplete: financingComplete(raw),
    deliveryAgentAssigned: booleanValue(agentAssigned),
    pendingTaskCount: tasks.filter((task) => task.enabled && !task.complete).length,
    totalTaskCount: tasks.length,
    tasks,
  };
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  return null;
}

function assertTokenResponse(value: unknown): TeslaTokenResponse {
  if (!isRecord(value)) throw new Error("Tesla returned an invalid owner token response");
  const expiresIn = Number(value.expires_in);
  if (
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.token_type !== "string" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("Tesla owner token response is missing required fields");
  }
  return { ...value, expires_in: expiresIn } as unknown as TeslaTokenResponse;
}

export function ownerCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

export class OwnerTeslaClient implements OwnerGateway {
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(requestTimeoutMs: number, fetchImplementation?: typeof fetch) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImplementation ?? fetch;
  }

  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): URL {
    const url = new URL(OWNER_AUTHORIZATION_URL);
    url.searchParams.set("client_id", OWNER_CLIENT_ID);
    url.searchParams.set("redirect_uri", OWNER_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email offline_access");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "login");
    return url;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<TeslaTokenResponse> {
    return this.#tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OWNER_CLIENT_ID,
      code: input.code,
      redirect_uri: OWNER_REDIRECT_URI,
      code_verifier: input.codeVerifier,
    }));
  }

  async refresh(refreshToken: string): Promise<TeslaTokenResponse> {
    return this.#tokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OWNER_CLIENT_ID,
      refresh_token: refreshToken,
    }));
  }

  async getOrders(accessToken: string): Promise<TeslaOrder[]> {
    const raw = await this.#get(new URL(OWNER_ORDERS_URL), accessToken);
    if (!isRecord(raw) || !Array.isArray(raw.response)) {
      throw new Error("Tesla returned an invalid owner orders response");
    }
    return raw.response.filter(isRecord) as TeslaOrder[];
  }

  async getOrderDetails(
    accessToken: string,
    referenceNumber: string,
    countryCode?: string,
  ): Promise<unknown> {
    const normalizedCountryCode = countryCode?.trim().toUpperCase();
    const url = new URL(OWNER_DETAILS_URL);
    url.searchParams.set("deviceLanguage", "en");
    url.searchParams.set(
      "deviceCountry",
      normalizedCountryCode && /^[A-Z]{2}$/.test(normalizedCountryCode)
        ? normalizedCountryCode
        : "US",
    );
    url.searchParams.set("referenceNumber", referenceNumber);
    url.searchParams.set("appVersion", "9.99.9-9999");
    return this.#get(url, accessToken);
  }

  async #tokenRequest(body: URLSearchParams): Promise<TeslaTokenResponse> {
    const response = await this.#request(new URL(OWNER_TOKEN_URL), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    return assertTokenResponse(await this.#parse(response));
  }

  async #get(url: URL, accessToken: string): Promise<unknown> {
    const response = await this.#request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    return this.#parse(response);
  }

  async #request(
    url: URL,
    input: {
      method: "GET" | "POST";
      headers: Record<string, string>;
      body?: string;
    },
  ): Promise<OwnerHttpResponse> {
    const requestHeaders: Record<string, string> = {
      "user-agent": "OrderPulse/0.4.2",
      "x-tesla-user-agent": "TeslaApp/4.10.0",
      ...input.headers,
    };
    const response = await this.#fetch(url, {
      method: input.method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      redirect: "error",
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await boundedResponseText(response),
    };
  }

  async #parse(response: OwnerHttpResponse): Promise<unknown> {
    const { text } = response;
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const body = isRecord(parsed) ? parsed : {};
      const code = typeof body.error === "string" ? body.error : null;
      const description =
        typeof body.error_description === "string" ? body.error_description : null;
      throw new TeslaRequestError({
        message: description || code || `Tesla owner request failed with HTTP ${response.status}`,
        status: response.status,
        code,
        transactionId: headerValue(response.headers, "x-txid"),
        retryAfterSeconds: retryAfterSeconds(headerValue(response.headers, "retry-after")),
      });
    }
    return parsed;
  }
}
