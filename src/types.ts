export interface TeslaTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface StoredTeslaTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessExpiresAt: number;
  scopes: string;
  fleetBaseUrl: string;
  subject: string | null;
  updatedAt: number;
}

export interface OAuthTransaction {
  state: string;
  nonce: string;
  createdAt: number;
}

export interface TeslaOrder extends Record<string, unknown> {
  referenceNumber?: string;
  orderStatus?: string;
  modelCode?: string;
  vin?: string;
  mktOptions?: string | string[];
}

export interface TeslaRegionResult {
  raw: unknown;
  fleetBaseUrl: string;
}

export interface TeslaGateway {
  buildAuthorizationUrl(input: { state: string; nonce: string }): URL;
  exchangeAuthorizationCode(input: {
    code: string;
    expectedNonce: string;
  }): Promise<{ tokens: TeslaTokenResponse; subject: string | null }>;
  getRegion(accessToken: string): Promise<TeslaRegionResult>;
  getOrders(accessToken: string, fleetBaseUrl: string): Promise<TeslaOrder[]>;
  refresh(refreshToken: string): Promise<TeslaTokenResponse>;
}
