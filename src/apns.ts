import { connect, constants, type IncomingHttpHeaders } from "node:http2";

import { importPKCS8, SignJWT } from "jose";

import type { ServiceConfig } from "./config.js";
import type { PushMessage, PushResult, PushSender } from "./mobile-types.js";

const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60_000;
const PERMANENT_DEVICE_ERRORS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "MissingDeviceToken",
  "Unregistered",
]);

function responseReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "reason" in parsed &&
      typeof parsed.reason === "string"
    ) {
      return parsed.reason;
    }
  } catch {
    // A non-JSON APNs response is reduced to its HTTP status below.
  }
  return null;
}

export class ApnsClient implements PushSender {
  readonly #keyId: string;
  readonly #teamId: string;
  readonly #topic: string;
  readonly #privateKeyPem: string;
  readonly #timeoutMs: number;
  #privateKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
  #providerToken: { value: string; createdAt: number } | null = null;

  constructor(config: ServiceConfig) {
    if (!config.apnsEnabled || !config.apnsKeyId || !config.apnsTeamId || !config.apnsPrivateKey) {
      throw new Error("APNs is not fully configured");
    }
    this.#keyId = config.apnsKeyId;
    this.#teamId = config.apnsTeamId;
    this.#topic = config.apnsTopic;
    this.#privateKeyPem = config.apnsPrivateKey;
    this.#timeoutMs = config.requestTimeoutMs;
  }

  async #authorizationToken(): Promise<string> {
    const now = Date.now();
    if (this.#providerToken && now - this.#providerToken.createdAt < PROVIDER_TOKEN_LIFETIME_MS) {
      return this.#providerToken.value;
    }
    this.#privateKey ??= await importPKCS8(this.#privateKeyPem, "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.#keyId })
      .setIssuer(this.#teamId)
      .setIssuedAt(Math.floor(now / 1_000))
      .sign(this.#privateKey);
    this.#providerToken = { value, createdAt: now };
    return value;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const providerToken = await this.#authorizationToken();
    const host =
      message.environment === "production"
        ? "api.push.apple.com"
        : "api.sandbox.push.apple.com";
    const payload = JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: "default",
        "thread-id": "order-status",
      },
      eventId: message.eventId,
      eventType: message.eventType,
    });

    return new Promise<PushResult>((resolve) => {
      const session = connect(`https://${host}`);
      let settled = false;
      const finish = (result: PushResult): void => {
        if (settled) return;
        settled = true;
        session.close();
        resolve(result);
      };
      session.once("error", () => {
        finish({ accepted: false, errorCode: "apns_connection_error", permanentFailure: false });
      });

      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${message.deviceToken}`,
        authorization: `bearer ${providerToken}`,
        "apns-topic": this.#topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": `orderpulse-${message.eventId}`,
      });
      let status = 0;
      let responseBody = "";
      request.setEncoding("utf8");
      request.on("response", (headers: IncomingHttpHeaders) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk: string) => {
        if (responseBody.length < 4_096) responseBody += chunk;
      });
      request.once("error", () => {
        finish({ accepted: false, errorCode: "apns_request_error", permanentFailure: false });
      });
      request.once("end", () => {
        if (status === 200) {
          finish({ accepted: true, errorCode: null, permanentFailure: false });
          return;
        }
        const reason = responseReason(responseBody) ?? `apns_http_${status || "unknown"}`;
        finish({
          accepted: false,
          errorCode: reason,
          permanentFailure: PERMANENT_DEVICE_ERRORS.has(reason),
        });
      });
      request.setTimeout(this.#timeoutMs, () => {
        request.close(constants.NGHTTP2_CANCEL);
        finish({ accepted: false, errorCode: "apns_timeout", permanentFailure: false });
      });
      request.end(payload);
    });
  }
}
