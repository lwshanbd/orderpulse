import type { OrderEvent } from "./order-types.js";

export type ApnsEnvironment = "sandbox" | "production";

export interface MobileDevice {
  id: string;
  name: string;
  pushEnabled: boolean;
  apnsEnvironment: ApnsEnvironment | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface NotificationJob {
  event: OrderEvent;
  deviceId: string;
  deviceToken: string;
  environment: ApnsEnvironment;
  attemptCount: number;
}

export interface PushMessage {
  deviceToken: string;
  environment: ApnsEnvironment;
  title: string;
  body: string;
  eventId: number;
  eventType: string;
}

export interface PushResult {
  accepted: boolean;
  errorCode: string | null;
  permanentFailure: boolean;
}

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}
