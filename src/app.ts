import { readFile } from "node:fs/promises";
import { z } from "zod";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { ServiceConfig } from "./config.js";
import { MobileCredentials, randomBase64Url, safeEqual } from "./crypto.js";
import type { OrderPulseDatabase } from "./database.js";
import type { MobileDevice } from "./mobile-types.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";
import type { OwnerTokenService } from "./owner-service.js";
import type { OrderMonitor } from "./order-monitor.js";
import type { OrderEvent, OrderSnapshot, PollRun } from "./order-types.js";
import { describeShape, sanitizeOrder } from "./redact.js";
import { TeslaRequestError } from "./tesla.js";
import { accessTokenScopes } from "./token-scopes.js";
import type { TeslaGateway } from "./types.js";
import type { TeslaTokenService } from "./token-service.js";

interface AppDependencies {
  config: ServiceConfig;
  database: OrderPulseDatabase;
  tesla: TeslaGateway;
  tokenService: TeslaTokenService;
  orderMonitor: OrderMonitor;
  mobileCredentials?: MobileCredentials;
  notifications?: NotificationDispatcher;
  ownerService?: OwnerTokenService;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

interface EventsQuery {
  limit?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    mobileDeviceId?: string;
  }
}

const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 10;
const MAX_TRACKED_LOGIN_IPS = 1_024;
const PAIRING_WINDOW_MS = 15 * 60 * 1_000;
const MAX_PAIRING_FAILURES = 10;
const MOBILE_REFRESH_COOLDOWN_MS = 5 * 60 * 1_000;
const pairingRequestSchema = z.object({
  code: z.string().min(8).max(16),
  name: z.string().trim().min(1).max(80),
});
const pushTokenSchema = z.object({
  token: z.string().regex(/^[A-Fa-f0-9]{64,400}$/),
  environment: z.enum(["sandbox", "production"]),
});
const ownerCallbackSchema = z.object({
  callbackUrl: z.string().trim().url().max(8_192),
});

function htmlPage(title: string, message: string): string {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapedTitle}</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      body { margin: 0; display: grid; min-height: 100vh; place-items: center; background: #101114; }
      main { width: min(34rem, calc(100% - 3rem)); padding: 2rem; border-radius: 1rem; background: #1b1d22; box-shadow: 0 1rem 3rem #0006; }
      h1 { margin-top: 0; font-size: 1.5rem; }
      p { line-height: 1.6; color: #c9cbd1; }
    </style>
  </head>
  <body><main><h1>${escapedTitle}</h1><p>${escapedMessage}</p></main></body>
</html>`;
}

function ownerAuthorizationPage(authorizationUrl: URL): string {
  const safeUrl = escapeHtml(authorizationUrl.toString());
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>连接 Tesla 订单详情</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      body { margin: 0; display: grid; min-height: 100vh; place-items: center; background: #101114; }
      main { width: min(38rem, calc(100% - 3rem)); padding: 2rem; border-radius: 1rem; background: #1b1d22; box-shadow: 0 1rem 3rem #0006; }
      h1 { margin-top: 0; font-size: 1.5rem; }
      p, li { line-height: 1.55; color: #c9cbd1; }
      a, button { display: inline-block; border: 0; border-radius: .7rem; padding: .8rem 1rem; background: #e82127; color: white; font: inherit; font-weight: 650; text-decoration: none; cursor: pointer; }
      input { box-sizing: border-box; width: 100%; margin: .7rem 0 1rem; border: 1px solid #666; border-radius: .7rem; padding: .8rem; font: inherit; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body><main>
    <h1>连接 Tesla 订单详情</h1>
    <ol>
      <li>在新窗口打开 Tesla 官方登录页面并完成登录。</li>
      <li>最终浏览器可能提示无法打开链接。复制以 <code>tesla://auth/callback</code> 开头的完整回调地址；这是 Tesla 当前为 ownerapi 注册的地址。</li>
      <li>回到本页，粘贴地址并提交。OrderPulse 不会接触你的 Tesla 密码或 MFA。</li>
    </ol>
    <p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">打开 Tesla 登录</a></p>
    <form method="post" action="/oauth/owner/complete">
      <label for="callbackUrl">Tesla 最终回调地址</label>
      <input id="callbackUrl" name="callbackUrl" type="url" required autocomplete="off" placeholder="tesla://auth/callback?code=...">
      <button type="submit">保存 Owner 授权</button>
    </form>
  </main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

function parseBasicAuthorization(header: string | undefined): [string, string] | undefined {
  if (!header?.startsWith("Basic ")) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return undefined;
    }
    return [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return undefined;
  }
}

function publicError(error: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof TeslaRequestError) {
    return {
      statusCode: error.status === 401 ? 401 : 502,
      body: {
        error: "tesla_api_error",
        message: error.message,
        ...(error.code ? { teslaCode: error.code } : {}),
        ...(error.transactionId ? { transactionId: error.transactionId } : {}),
      },
    };
  }

  if (error instanceof Error && error.message === "Tesla authorization is not configured") {
    return {
      statusCode: 409,
      body: { error: "not_authorized", message: error.message },
    };
  }

  return {
    statusCode: 500,
    body: { error: "internal_error", message: "The service could not complete the request" },
  };
}

function isoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function serializeSnapshot(snapshot: OrderSnapshot): Record<string, unknown> {
  return {
    ...snapshot,
    firstSeenAt: isoTime(snapshot.firstSeenAt),
    lastSeenAt: isoTime(snapshot.lastSeenAt),
    lastChangedAt: isoTime(snapshot.lastChangedAt),
    inactiveAt: isoTime(snapshot.inactiveAt),
  };
}

function serializeEvent(event: OrderEvent): Record<string, unknown> {
  return {
    ...event,
    notificationDeliveredAt: isoTime(event.notificationDeliveredAt),
    createdAt: isoTime(event.createdAt),
  };
}

function serializePollRun(run: PollRun | null): Record<string, unknown> | null {
  if (!run) return null;
  return {
    ...run,
    startedAt: isoTime(run.startedAt),
    finishedAt: isoTime(run.finishedAt),
  };
}

function serializeMobileDevice(device: MobileDevice): Record<string, unknown> {
  return {
    ...device,
    createdAt: isoTime(device.createdAt),
    updatedAt: isoTime(device.updatedAt),
    revokedAt: isoTime(device.revokedAt),
  };
}

export function createApp({
  config,
  database,
  tesla,
  tokenService,
  orderMonitor,
  mobileCredentials = new MobileCredentials(config.tokenEncryptionKey),
  notifications,
  ownerService,
}: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1_024,
    requestTimeout: config.requestTimeoutMs + 5_000,
  });
  const loginAttempts = new Map<string, LoginAttempt>();
  const pairingAttempts = new Map<string, LoginAttempt>();

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    async (_request: FastifyRequest, body: string) =>
      Object.fromEntries(new URLSearchParams(body)),
  );

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    if (request.url.startsWith("/oauth/") || request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }

    if (reply.getHeader("content-type")?.toString().startsWith("text/html")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    return payload;
  });

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    if (loginAttempts.size >= MAX_TRACKED_LOGIN_IPS) {
      for (const [ip, attempt] of loginAttempts) {
        if (attempt.resetAt <= now) loginAttempts.delete(ip);
      }
      while (loginAttempts.size >= MAX_TRACKED_LOGIN_IPS) {
        const oldestIp = loginAttempts.keys().next().value as string | undefined;
        if (!oldestIp) break;
        loginAttempts.delete(oldestIp);
      }
    }
    const previous = loginAttempts.get(request.ip);
    const authorizationHeader = request.headers.authorization;
    const credentials = parseBasicAuthorization(authorizationHeader);
    const authorized =
      credentials !== undefined &&
      safeEqual(credentials[0], config.adminUsername) &&
      safeEqual(credentials[1], config.adminPassword);

    if (authorized) {
      loginAttempts.delete(request.ip);
      return;
    }

    reply.header("WWW-Authenticate", 'Basic realm="OrderPulse", charset="UTF-8"');
    if (!authorizationHeader) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (previous && previous.resetAt > now && previous.failures >= MAX_LOGIN_FAILURES) {
      reply.header("Retry-After", Math.ceil((previous.resetAt - now) / 1_000));
      await reply.code(429).send({ error: "too_many_attempts" });
      return;
    }

    const current = previous && previous.resetAt > now ? previous : { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
    current.failures += 1;
    loginAttempts.set(request.ip, current);
    if (current.failures >= MAX_LOGIN_FAILURES) {
      reply.header("Retry-After", Math.ceil((current.resetAt - now) / 1_000));
      await reply.code(429).send({ error: "too_many_attempts" });
      return;
    }
    await reply.code(401).send({ error: "unauthorized" });
  }

  async function requireMobile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const token = header.slice(7);
    const deviceId = token.length >= 32
      ? database.authenticateMobileDevice(mobileCredentials.hash(token))
      : null;
    if (!deviceId) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.mobileDeviceId = deviceId;
  }

  function mobileBootstrapPayload(): Record<string, unknown> {
    const monitorStatus = orderMonitor.status();
    return {
      serverTime: new Date().toISOString(),
      apnsEnabled: notifications?.enabled ?? false,
      ownerAuthorized: ownerService?.authorized ?? false,
      orders: database.listOrderSnapshots().map(serializeSnapshot),
      events: database.listOrderEvents(50).map(serializeEvent),
      polling: {
        enabled: monitorStatus.enabled,
        inProgress: monitorStatus.inProgress,
        nextPollAt: isoTime(monitorStatus.nextPollAt),
        latestRun: serializePollRun(monitorStatus.latestRun),
      },
    };
  }

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", async (_request, reply) => {
    try {
      const publicKey = await readFile(config.teslaPublicKeyFile, "utf8");
      if (!publicKey.includes("BEGIN PUBLIC KEY")) {
        throw new Error("Invalid public key file");
      }
      reply.header("Cache-Control", "public, max-age=300");
      return reply.type("application/x-pem-file").send(publicKey);
    } catch {
      return reply.code(503).send({ error: "public_key_unavailable" });
    }
  });

  app.get("/oauth/tesla/start", { preHandler: requireAdmin }, async (_request, reply) => {
    const transaction = {
      state: randomBase64Url(),
      nonce: randomBase64Url(),
      createdAt: Date.now(),
    };
    database.createOAuthTransaction(transaction);
    return reply.redirect(
      tesla.buildAuthorizationUrl({ state: transaction.state, nonce: transaction.nonce }).toString(),
    );
  });

  app.get("/oauth/owner/start", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!ownerService) return reply.code(503).send({ error: "owner_api_unavailable" });
    const authorizationUrl = ownerService.beginAuthorization();
    return reply
      .type("text/html; charset=utf-8")
      .send(ownerAuthorizationPage(authorizationUrl));
  });

  app.post("/oauth/owner/complete", { preHandler: requireAdmin }, async (request, reply) => {
    if (!ownerService) return reply.code(503).send({ error: "owner_api_unavailable" });
    const parsed = ownerCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(htmlPage("Owner 授权失败", "请粘贴 Tesla 空白页地址栏中的完整回调地址。"));
    }
    try {
      await ownerService.completeAuthorization(parsed.data.callbackUrl);
      return reply
        .type("text/html; charset=utf-8")
        .send(htmlPage("订单详情已连接", "Owner token 已加密保存在 NAS。现在可以执行一次手动轮询建立详情基线。"));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Owner authorization failed";
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(htmlPage("Owner 授权失败", message));
    }
  });

  app.get<{ Querystring: CallbackQuery }>("/oauth/tesla/callback", async (request, reply) => {
    const { code, state, error, error_description: errorDescription } = request.query;
    if (!state) {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(htmlPage("授权失败", "回调缺少 state，请从 OrderPulse 重新开始授权。"));
    }

    const transaction = database.consumeOAuthTransaction(state, config.oauthTransactionTtlSeconds);
    if (!transaction) {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(htmlPage("授权已失效", "授权请求已过期、已经使用，或 state 不匹配。"));
    }

    if (error) {
      const description = errorDescription ? `（${errorDescription}）` : "";
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(htmlPage("Tesla 未完成授权", `${error}${description}`));
    }

    if (!code) {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(htmlPage("授权失败", "回调缺少 authorization code。"));
    }

    try {
      const stored = await tokenService.saveAuthorization({
        code,
        expectedNonce: transaction.nonce,
        defaultFleetBaseUrl: config.teslaFleetBaseUrl,
      });
      return reply
        .type("text/html; charset=utf-8")
        .send(
          htmlPage(
            "OrderPulse 已连接",
            `Tesla 授权已经安全保存。Fleet API 区域：${stored.fleetBaseUrl ?? "将在首次查询时检测"}。`,
          ),
        );
    } catch (caught) {
      const safe = publicError(caught);
      return reply
        .code(safe.statusCode)
        .type("text/html; charset=utf-8")
        .send(htmlPage("授权失败", String(safe.body.message)));
    }
  });

  app.get("/api/status", { preHandler: requireAdmin }, async () => {
    const tokens = database.loadTeslaTokens();
    const storedScopes = tokens?.scopes.split(/\s+/).filter(Boolean) ?? [];
    const scopes =
      storedScopes.length > 0 || !tokens ? storedScopes : accessTokenScopes(tokens.accessToken);
    if (tokens && storedScopes.length === 0 && scopes.length > 0) {
      database.updateScopes(scopes.join(" "));
    }
    const ownerTokens = database.loadOwnerTokens();
    return {
      authorized: tokens !== null,
      ownerAuthorized: ownerTokens !== null,
      ...(ownerTokens
        ? {
            ownerExpiresAt: new Date(ownerTokens.accessExpiresAt).toISOString(),
            ownerUpdatedAt: new Date(ownerTokens.updatedAt).toISOString(),
          }
        : {}),
      ...(tokens
        ? {
            expiresAt: new Date(tokens.accessExpiresAt).toISOString(),
            scopes,
            fleetBaseUrl: tokens.fleetBaseUrl,
            updatedAt: new Date(tokens.updatedAt).toISOString(),
          }
        : {}),
    };
  });

  app.get("/api/orders", { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const result = await orderMonitor.pollNow("live_api");
      return {
        count: result.orders.length,
        orders: result.orders.map(sanitizeOrder),
        reconciliation: result.reconciliation,
        polledAt: new Date(result.finishedAt).toISOString(),
      };
    } catch (caught) {
      const safe = publicError(caught);
      return reply.code(safe.statusCode).send(safe.body);
    }
  });

  app.get("/api/order-state", { preHandler: requireAdmin }, async () => {
    const orders = database.listOrderSnapshots().map(serializeSnapshot);
    return { count: orders.length, orders };
  });

  app.get<{ Querystring: EventsQuery }>(
    "/api/events",
    { preHandler: requireAdmin },
    async (request) => {
      const requestedLimit = Number(request.query.limit ?? 50);
      const limit = Number.isSafeInteger(requestedLimit) ? requestedLimit : 50;
      const events = database.listOrderEvents(limit).map(serializeEvent);
      return { count: events.length, events };
    },
  );

  app.get("/api/polling/status", { preHandler: requireAdmin }, async () => {
    const status = orderMonitor.status();
    return {
      ...status,
      nextPollAt: isoTime(status.nextPollAt),
      latestRun: serializePollRun(status.latestRun),
    };
  });

  app.post("/api/devices/pairing-code", { preHandler: requireAdmin }, async () => {
    const code = mobileCredentials.createPairingCode();
    const normalizedCode = mobileCredentials.normalizePairingCode(code);
    const expiresAt = Date.now() + config.mobilePairingTtlSeconds * 1_000;
    database.createMobilePairingCode(mobileCredentials.hash(normalizedCode), expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.get("/api/devices", { preHandler: requireAdmin }, async () => {
    const devices = database.listMobileDevices().map(serializeMobileDevice);
    return { count: devices.length, apnsEnabled: notifications?.enabled ?? false, devices };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/devices/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const revoked = database.revokeMobileDevice(request.params.id);
      return revoked ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/devices/:id/test-notification",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!notifications?.enabled) {
        return reply.code(503).send({ error: "apns_not_configured" });
      }
      const result = await notifications.sendTest(request.params.id);
      if (!result) return reply.code(404).send({ error: "push_target_not_found" });
      return result.accepted
        ? { accepted: true }
        : reply.code(502).send({ accepted: false, error: result.errorCode });
    },
  );

  app.post("/api/mobile/pair", async (request, reply) => {
    const now = Date.now();
    const previous = pairingAttempts.get(request.ip);
    if (previous && previous.resetAt > now && previous.failures >= MAX_PAIRING_FAILURES) {
      reply.header("Retry-After", Math.ceil((previous.resetAt - now) / 1_000));
      return reply.code(429).send({ error: "too_many_pairing_attempts" });
    }
    const parsed = pairingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const normalizedCode = mobileCredentials.normalizePairingCode(parsed.data.code);
    const accessToken = mobileCredentials.createAccessToken();
    const deviceId = randomBase64Url(16);
    const paired = normalizedCode.length === 8 && database.pairMobileDevice({
      codeHash: mobileCredentials.hash(normalizedCode),
      deviceId,
      credentialHash: mobileCredentials.hash(accessToken),
      name: parsed.data.name,
      now,
    });
    if (!paired) {
      const current = previous && previous.resetAt > now
        ? previous
        : { failures: 0, resetAt: now + PAIRING_WINDOW_MS };
      current.failures += 1;
      pairingAttempts.set(request.ip, current);
      if (current.failures >= MAX_PAIRING_FAILURES) {
        reply.header("Retry-After", Math.ceil((current.resetAt - now) / 1_000));
        return reply.code(429).send({ error: "too_many_pairing_attempts" });
      }
      return reply.code(401).send({ error: "invalid_or_expired_pairing_code" });
    }
    pairingAttempts.delete(request.ip);
    return { deviceId, accessToken };
  });

  app.get("/api/mobile/bootstrap", { preHandler: requireMobile }, async () =>
    mobileBootstrapPayload(),
  );

  app.post("/api/mobile/refresh", { preHandler: requireMobile }, async (_request, reply) => {
    const status = orderMonitor.status();
    const latestStartedAt = status.latestRun?.startedAt ?? null;
    if (!status.inProgress && latestStartedAt !== null) {
      const retryAfterMs = latestStartedAt + MOBILE_REFRESH_COOLDOWN_MS - Date.now();
      if (retryAfterMs > 0) {
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
        reply.header("Retry-After", retryAfterSeconds);
        return {
          polled: false,
          retryAfterSeconds,
          bootstrap: mobileBootstrapPayload(),
        };
      }
    }

    try {
      await orderMonitor.pollNow("manual");
      return {
        polled: true,
        retryAfterSeconds: Math.ceil(MOBILE_REFRESH_COOLDOWN_MS / 1_000),
        bootstrap: mobileBootstrapPayload(),
      };
    } catch (caught) {
      const safe = publicError(caught);
      return reply.code(safe.statusCode).send(safe.body);
    }
  });

  app.post(
    "/api/mobile/owner-authorization/start",
    { preHandler: requireMobile },
    async (_request, reply) => {
      if (!ownerService) return reply.code(503).send({ error: "owner_api_unavailable" });
      if (ownerService.authorized) {
        return reply.code(409).send({ error: "owner_already_authorized" });
      }
      return { authorizationUrl: ownerService.beginAuthorization().toString() };
    },
  );

  app.post(
    "/api/mobile/owner-authorization/complete",
    { preHandler: requireMobile },
    async (request, reply) => {
      if (!ownerService) return reply.code(503).send({ error: "owner_api_unavailable" });
      const parsed = ownerCallbackSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      try {
        await ownerService.completeAuthorization(parsed.data.callbackUrl);
        return reply.code(204).send();
      } catch {
        return reply.code(400).send({ error: "owner_authorization_failed" });
      }
    },
  );

  app.put("/api/mobile/device-token", { preHandler: requireMobile }, async (request, reply) => {
    const parsed = pushTokenSchema.safeParse(request.body);
    if (!parsed.success || !request.mobileDeviceId) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (config.apnsEnabled && parsed.data.environment !== config.apnsEnvironment) {
      return reply.code(409).send({
        error: "apns_environment_mismatch",
        expectedEnvironment: config.apnsEnvironment,
      });
    }
    const registered = database.registerMobilePushToken(
      request.mobileDeviceId,
      parsed.data.token.toLowerCase(),
      parsed.data.environment,
    );
    return registered ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/api/mobile/device-token", { preHandler: requireMobile }, async (request, reply) => {
    if (request.mobileDeviceId) database.removeMobilePushToken(request.mobileDeviceId);
    return reply.code(204).send();
  });

  app.delete("/api/mobile/device", { preHandler: requireMobile }, async (request, reply) => {
    if (request.mobileDeviceId) database.revokeMobileDevice(request.mobileDeviceId);
    return reply.code(204).send();
  });

  app.post("/api/polling/run", { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const result = await orderMonitor.pollNow("manual");
      return {
        pollRunId: result.pollRunId,
        orderCount: result.orders.length,
        reconciliation: result.reconciliation,
        finishedAt: new Date(result.finishedAt).toISOString(),
      };
    } catch (caught) {
      const safe = publicError(caught);
      return reply.code(safe.statusCode).send(safe.body);
    }
  });

  app.get("/api/orders/schema", { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const orders = await tokenService.getOrders();
      return { count: orders.length, fields: describeShape(orders) };
    } catch (caught) {
      const safe = publicError(caught);
      return reply.code(safe.statusCode).send(safe.body);
    }
  });

  app.get("/api/order-details/schema", { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      if (!ownerService?.authorized) {
        return reply.code(409).send({ error: "owner_not_authorized" });
      }
      const details = await ownerService.getFirstOrderDetails();
      return {
        source: "undocumented_tesla_delivery_api",
        warning: "This endpoint is not part of the supported Tesla Fleet API",
        fields: describeShape(details),
      };
    } catch (caught) {
      if (caught instanceof TeslaRequestError) {
        return reply.code(502).send({
          error: "order_details_probe_failed",
          upstreamStatus: caught.status,
          ...(caught.code ? { teslaCode: caught.code } : {}),
          ...(caught.transactionId ? { transactionId: caught.transactionId } : {}),
        });
      }
      const safe = publicError(caught);
      return reply.code(safe.statusCode).send(safe.body);
    }
  });

  app.delete("/api/authorization", { preHandler: requireAdmin }, async (_request, reply) => {
    database.deleteTeslaTokens();
    return reply.code(204).send();
  });

  app.delete("/api/owner-authorization", { preHandler: requireAdmin }, async (_request, reply) => {
    ownerService?.revoke();
    return reply.code(204).send();
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "not_found" }));

  app.setErrorHandler(async (error, _request, reply) => {
    const safe = publicError(error);
    await reply.code(safe.statusCode).send(safe.body);
  });

  return app;
}
