import type { OrderDeliveryDetails } from "./types.js";

export type OrderEventType =
  | "baseline_created"
  | "status_changed"
  | "configuration_changed"
  | "order_inactive"
  | "order_reappeared";

export type PollSource = "scheduled" | "manual" | "live_api";
export type PollOutcome = "running" | "success" | "error";

export interface TrackedOrder {
  orderKey: string;
  referenceSuffix: string | null;
  orderStatus: string | null;
  orderSubstatus: string | null;
  modelCode: string | null;
  marketOptions: string[];
  delivery: OrderDeliveryDetails | null;
}

export interface OrderSnapshot {
  orderId: string;
  referenceNumber: string | null;
  orderStatus: string | null;
  orderSubstatus: string | null;
  modelCode: string | null;
  marketOptions: string[];
  delivery: OrderDeliveryDetails | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastChangedAt: number;
  missingCount: number;
  inactiveAt: number | null;
}

export interface OrderEvent {
  id: number;
  orderId: string;
  referenceNumber: string | null;
  type: OrderEventType;
  previousStatus: string | null;
  previousSubstatus: string | null;
  currentStatus: string | null;
  currentSubstatus: string | null;
  notificationEligible: boolean;
  notificationDeliveredAt: number | null;
  createdAt: number;
}

export interface OrderReconciliationResult {
  baselineCount: number;
  eventCount: number;
  notificationEligibleCount: number;
  activeOrderCount: number;
}

export interface PollRun {
  id: number;
  source: PollSource;
  outcome: PollOutcome;
  startedAt: number;
  finishedAt: number | null;
  orderCount: number | null;
  eventCount: number | null;
  errorCode: string | null;
}
