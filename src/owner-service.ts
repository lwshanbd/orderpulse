import { randomBase64Url } from "./crypto.js";
import type { OrderPulseDatabase } from "./database.js";
import { extractOrderDeliveryDetails, ownerCodeChallenge } from "./owner-api.js";
import { TeslaRequestError } from "./tesla.js";
import type { OwnerGateway, TeslaOrder } from "./types.js";

const OWNER_CALLBACK_PROTOCOL = "tesla:";
const OWNER_CALLBACK_HOST = "auth";
const OWNER_CALLBACK_PATH = "/callback";

export class OwnerTokenService {
  readonly #database: OrderPulseDatabase;
  readonly #owner: OwnerGateway;
  readonly #transactionTtlSeconds: number;
  #refreshInFlight: Promise<string> | null = null;

  constructor(
    database: OrderPulseDatabase,
    owner: OwnerGateway,
    transactionTtlSeconds: number,
  ) {
    this.#database = database;
    this.#owner = owner;
    this.#transactionTtlSeconds = transactionTtlSeconds;
  }

  get authorized(): boolean {
    return this.#database.hasOwnerTokens();
  }

  beginAuthorization(): URL {
    const state = `owner_${randomBase64Url()}`;
    const verifier = randomBase64Url(64);
    this.#database.createOAuthTransaction({
      state,
      nonce: verifier,
      createdAt: Date.now(),
    });
    return this.#owner.buildAuthorizationUrl({
      state,
      codeChallenge: ownerCodeChallenge(verifier),
    });
  }

  async completeAuthorization(callbackUrl: string): Promise<void> {
    let callback: URL;
    try {
      callback = new URL(callbackUrl);
    } catch {
      throw new Error("Owner callback URL is invalid");
    }
    if (
      callback.protocol !== OWNER_CALLBACK_PROTOCOL ||
      callback.hostname !== OWNER_CALLBACK_HOST ||
      callback.pathname !== OWNER_CALLBACK_PATH ||
      callback.username !== "" ||
      callback.password !== "" ||
      callback.port !== ""
    ) {
      throw new Error("Owner callback URL is not from Tesla");
    }
    const state = callback.searchParams.get("state");
    if (!state?.startsWith("owner_")) {
      throw new Error("Owner callback is missing its state");
    }
    const transaction = this.#database.consumeOAuthTransaction(
      state,
      this.#transactionTtlSeconds,
    );
    if (!transaction) throw new Error("Owner authorization has expired or was already used");
    const error = callback.searchParams.get("error");
    if (error) throw new Error(`Tesla owner authorization failed: ${error}`);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Owner callback is missing its authorization code");

    const tokens = await this.#owner.exchangeAuthorizationCode({
      code,
      codeVerifier: transaction.nonce,
    });
    this.#database.saveOwnerTokens({ tokens });
  }

  async getOrders(): Promise<TeslaOrder[]> {
    return this.#withAccessToken(async (accessToken) => {
      const orders = await this.#owner.getOrders(accessToken);
      const enriched: TeslaOrder[] = [];
      for (const order of orders) {
        if (typeof order.referenceNumber !== "string" || order.referenceNumber.length === 0) {
          enriched.push(order);
          continue;
        }
        const details = await this.#owner.getOrderDetails(
          accessToken,
          order.referenceNumber,
          order.countryCode,
        );
        enriched.push({
          ...order,
          orderPulseDelivery: extractOrderDeliveryDetails(order, details),
        });
      }
      return enriched;
    });
  }

  async getFirstOrderDetails(): Promise<unknown> {
    return this.#withAccessToken(async (accessToken) => {
      const orders = await this.#owner.getOrders(accessToken);
      const order = orders.find(
        (candidate) =>
          typeof candidate.referenceNumber === "string" && candidate.referenceNumber.length > 0,
      );
      if (!order?.referenceNumber) {
        throw new Error("Tesla did not return an active owner order");
      }
      return this.#owner.getOrderDetails(
        accessToken,
        order.referenceNumber,
        order.countryCode,
      );
    });
  }

  revoke(): void {
    this.#database.deleteOwnerTokens();
  }

  async #withAccessToken<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    const accessToken = await this.#getValidAccessToken();
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof TeslaRequestError) || error.status !== 401) throw error;
      return operation(await this.#forceRefresh(accessToken));
    }
  }

  async #getValidAccessToken(): Promise<string> {
    const stored = this.#database.loadOwnerTokens();
    if (!stored) throw new Error("Tesla Owner authorization is not configured");
    if (stored.accessExpiresAt - Date.now() > 60_000) return stored.accessToken;
    if (!this.#refreshInFlight) {
      this.#refreshInFlight = this.#refresh(stored.refreshToken).finally(() => {
        this.#refreshInFlight = null;
      });
    }
    return this.#refreshInFlight;
  }

  async #forceRefresh(rejectedAccessToken: string): Promise<string> {
    const current = this.#database.loadOwnerTokens();
    if (!current) throw new Error("Tesla Owner authorization is not configured");
    if (current.accessToken !== rejectedAccessToken) return current.accessToken;
    if (!this.#refreshInFlight) {
      this.#refreshInFlight = this.#refresh(current.refreshToken).finally(() => {
        this.#refreshInFlight = null;
      });
    }
    return this.#refreshInFlight;
  }

  async #refresh(refreshToken: string): Promise<string> {
    const tokens = await this.#owner.refresh(refreshToken);
    this.#database.saveOwnerTokens({ tokens, previousRefreshToken: refreshToken });
    return tokens.access_token;
  }
}

export class PreferredOrderProvider {
  readonly #owner: OwnerTokenService;
  readonly #fleet: { getOrders(): Promise<TeslaOrder[]> };

  constructor(owner: OwnerTokenService, fleet: { getOrders(): Promise<TeslaOrder[]> }) {
    this.#owner = owner;
    this.#fleet = fleet;
  }

  getOrders(): Promise<TeslaOrder[]> {
    return this.#owner.authorized ? this.#owner.getOrders() : this.#fleet.getOrders();
  }
}
