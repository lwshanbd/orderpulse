import { readFile } from "node:fs/promises";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { ServiceConfig } from "./config.js";
import { randomBase64Url, safeEqual } from "./crypto.js";
import type { OrderPulseDatabase } from "./database.js";
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

const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 10;

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

export function createApp({
  config,
  database,
  tesla,
  tokenService,
}: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1_024,
    requestTimeout: config.requestTimeoutMs + 5_000,
  });
  const loginAttempts = new Map<string, LoginAttempt>();

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
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    return payload;
  });

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    const previous = loginAttempts.get(request.ip);
    if (previous && previous.resetAt > now && previous.failures >= MAX_LOGIN_FAILURES) {
      reply.header("Retry-After", Math.ceil((previous.resetAt - now) / 1_000));
      await reply.code(429).send({ error: "too_many_attempts" });
      return;
    }

    const credentials = parseBasicAuthorization(request.headers.authorization);
    const authorized =
      credentials !== undefined &&
      safeEqual(credentials[0], config.adminUsername) &&
      safeEqual(credentials[1], config.adminPassword);

    if (authorized) {
      loginAttempts.delete(request.ip);
      return;
    }

    const current = previous && previous.resetAt > now ? previous : { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
    current.failures += 1;
    loginAttempts.set(request.ip, current);
    reply.header("WWW-Authenticate", 'Basic realm="OrderPulse", charset="UTF-8"');
    await reply.code(401).send({ error: "unauthorized" });
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
    return {
      authorized: tokens !== null,
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
      const orders = await tokenService.getOrders();
      return { count: orders.length, orders: orders.map(sanitizeOrder) };
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

  app.delete("/api/authorization", { preHandler: requireAdmin }, async (_request, reply) => {
    database.deleteTeslaTokens();
    return reply.code(204).send();
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "not_found" }));

  app.setErrorHandler(async (error, _request, reply) => {
    const safe = publicError(error);
    await reply.code(safe.statusCode).send(safe.body);
  });

  return app;
}
