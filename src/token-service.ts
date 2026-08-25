import type { OrderPulseDatabase } from "./database.js";
import { TeslaRequestError } from "./tesla.js";
import { grantedScopes } from "./token-scopes.js";
import type { TeslaGateway, TeslaOrder } from "./types.js";

export class TeslaTokenService {
  readonly #database: OrderPulseDatabase;
  readonly #tesla: TeslaGateway;
  #refreshInFlight: Promise<string> | null = null;

  constructor(database: OrderPulseDatabase, tesla: TeslaGateway) {
    this.#database = database;
    this.#tesla = tesla;
  }

  async saveAuthorization(input: {
    code: string;
    expectedNonce: string;
    defaultFleetBaseUrl: string;
  }): Promise<{ fleetBaseUrl: string; subject: string | null }> {
    const result = await this.#tesla.exchangeAuthorizationCode({
      code: input.code,
      expectedNonce: input.expectedNonce,
    });
    const tokens = {
      ...result.tokens,
      scope: grantedScopes(result.tokens),
    };
    this.#database.saveTeslaTokens({
      tokens,
      fleetBaseUrl: input.defaultFleetBaseUrl,
      subject: result.subject,
    });

    let fleetBaseUrl = input.defaultFleetBaseUrl;
    try {
      const region = await this.#tesla.getRegion(tokens.access_token);
      fleetBaseUrl = region.fleetBaseUrl;
      this.#database.updateFleetBaseUrl(fleetBaseUrl);
    } catch {
      // The token is still safely stored and the configured regional base URL remains usable.
    }
    return { fleetBaseUrl, subject: result.subject };
  }

  async getOrders(): Promise<TeslaOrder[]> {
    const accessToken = await this.#getValidAccessToken();
    const stored = this.#database.loadTeslaTokens();
    if (!stored) throw new Error("Tesla authorization is not configured");
    try {
      return await this.#getOrdersWithRegionRecovery(accessToken, stored.fleetBaseUrl);
    } catch (error) {
      if (!(error instanceof TeslaRequestError) || error.status !== 401) throw error;
      const refreshedAccessToken = await this.#forceRefresh(accessToken);
      const refreshedStored = this.#database.loadTeslaTokens();
      if (!refreshedStored) throw new Error("Tesla authorization is not configured");
      return this.#getOrdersWithRegionRecovery(
        refreshedAccessToken,
        refreshedStored.fleetBaseUrl,
      );
    }
  }

  async getOrderDetails(referenceNumber: string, countryCode?: string): Promise<unknown> {
    const accessToken = await this.#getValidAccessToken();
    try {
      return await this.#tesla.getOrderDetails(accessToken, referenceNumber, countryCode);
    } catch (error) {
      if (!(error instanceof TeslaRequestError) || error.status !== 401) throw error;
      const refreshedAccessToken = await this.#forceRefresh(accessToken);
      return this.#tesla.getOrderDetails(
        refreshedAccessToken,
        referenceNumber,
        countryCode,
      );
    }
  }

  async #getOrdersWithRegionRecovery(
    accessToken: string,
    fleetBaseUrl: string,
  ): Promise<TeslaOrder[]> {
    try {
      return await this.#tesla.getOrders(accessToken, fleetBaseUrl);
    } catch (error) {
      const regionRelated =
        error instanceof TeslaRequestError &&
        (error.status === 421 || error.code?.toLowerCase().includes("region") === true);
      if (!regionRelated) throw error;
      const region = await this.#tesla.getRegion(accessToken);
      this.#database.updateFleetBaseUrl(region.fleetBaseUrl);
      return this.#tesla.getOrders(accessToken, region.fleetBaseUrl);
    }
  }

  async #getValidAccessToken(): Promise<string> {
    const stored = this.#database.loadTeslaTokens();
    if (!stored) throw new Error("Tesla authorization is not configured");
    if (stored.accessExpiresAt - Date.now() > 60_000) {
      return stored.accessToken;
    }

    if (!this.#refreshInFlight) {
      this.#refreshInFlight = this.#refresh(stored).finally(() => {
        this.#refreshInFlight = null;
      });
    }
    return this.#refreshInFlight;
  }

  async #forceRefresh(rejectedAccessToken: string): Promise<string> {
    const current = this.#database.loadTeslaTokens();
    if (!current) throw new Error("Tesla authorization is not configured");
    if (current.accessToken !== rejectedAccessToken) return current.accessToken;
    if (!this.#refreshInFlight) {
      this.#refreshInFlight = this.#refresh(current).finally(() => {
        this.#refreshInFlight = null;
      });
    }
    return this.#refreshInFlight;
  }

  async #refresh(stored: NonNullable<ReturnType<OrderPulseDatabase["loadTeslaTokens"]>>): Promise<string> {
    const refreshed = await this.#tesla.refresh(stored.refreshToken);
    const tokens = {
      ...refreshed,
      scope: grantedScopes(refreshed, stored.scopes),
    };
    this.#database.saveTeslaTokens({
      tokens,
      previousRefreshToken: stored.refreshToken,
      fleetBaseUrl: stored.fleetBaseUrl,
      subject: stored.subject,
    });
    return tokens.access_token;
  }
}
