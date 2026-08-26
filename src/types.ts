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

export interface StoredOwnerTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessExpiresAt: number;
  scopes: string;
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
  orderSubstatus?: string;
  modelCode?: string;
  vin?: string;
  mktOptions?: string | string[];
  countryCode?: string;
  orderPulseDelivery?: OrderDeliveryDetails;
}

export interface OrderTaskSummary {
  id: string;
  title: string;
  complete: boolean;
  enabled: boolean;
  required: boolean;
  order: number | null;
}

export interface OrderDeliveryDetails {
  vin: string | null;
  vinAssigned: boolean;
  deliveryWindow: string | null;
  appointment: string | null;
  appointmentStatus: string | null;
  appointmentValid: boolean | null;
  rescheduleEligible: boolean | null;
  deliveryEstimatesEnabled: boolean | null;
  etaToDeliveryCenter: string | null;
  vehicleLocation: string | null;
  deliveryMethod: string | null;
  deliveryCenter: string | null;
  odometer: number | null;
  odometerUnit: string | null;
  reservationDate: string | null;
  orderBookedDate: string | null;
  licensePlate: string | null;
  financingComplete: boolean | null;
  deliveryAgentAssigned: boolean | null;
  pendingTaskCount: number;
  totalTaskCount: number;
  tasks: OrderTaskSummary[];
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
  getOrderDetails(
    accessToken: string,
    referenceNumber: string,
    countryCode?: string,
  ): Promise<unknown>;
  refresh(refreshToken: string): Promise<TeslaTokenResponse>;
}

export interface OwnerGateway {
  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): URL;
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<TeslaTokenResponse>;
  refresh(refreshToken: string): Promise<TeslaTokenResponse>;
  getOrderDetails(
    accessToken: string,
    referenceNumber: string,
    countryCode?: string,
  ): Promise<unknown>;
}
