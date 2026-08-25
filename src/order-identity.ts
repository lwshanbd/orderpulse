import { createHmac, hkdfSync } from "node:crypto";

import type { TrackedOrder } from "./order-types.js";
import type { TeslaOrder } from "./types.js";

function optionalString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function normalizedMarketOptions(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [
    ...new Set(
      raw
        .slice(0, 256)
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 256),
    ),
  ].sort();
}

function normalizeDelivery(order: TeslaOrder): TrackedOrder["delivery"] {
  const delivery = order.orderPulseDelivery;
  if (!delivery) return null;
  return {
    vin: optionalString(delivery.vin, 64),
    vinAssigned: delivery.vinAssigned === true,
    deliveryWindow: optionalString(delivery.deliveryWindow, 512),
    appointment: optionalString(delivery.appointment, 1_024),
    appointmentStatus: optionalString(delivery.appointmentStatus, 256),
    appointmentValid:
      typeof delivery.appointmentValid === "boolean" ? delivery.appointmentValid : null,
    rescheduleEligible:
      typeof delivery.rescheduleEligible === "boolean" ? delivery.rescheduleEligible : null,
    deliveryEstimatesEnabled:
      typeof delivery.deliveryEstimatesEnabled === "boolean"
        ? delivery.deliveryEstimatesEnabled
        : null,
    etaToDeliveryCenter: optionalString(delivery.etaToDeliveryCenter, 512),
    vehicleLocation: optionalString(delivery.vehicleLocation, 512),
    deliveryMethod: optionalString(delivery.deliveryMethod, 256),
    deliveryCenter: optionalString(delivery.deliveryCenter, 512),
    odometer:
      typeof delivery.odometer === "number" && Number.isFinite(delivery.odometer)
        ? delivery.odometer
        : null,
    odometerUnit: optionalString(delivery.odometerUnit, 32),
    reservationDate: optionalString(delivery.reservationDate, 256),
    orderBookedDate: optionalString(delivery.orderBookedDate, 256),
    licensePlate: optionalString(delivery.licensePlate, 64),
    financingComplete:
      typeof delivery.financingComplete === "boolean" ? delivery.financingComplete : null,
    deliveryAgentAssigned:
      typeof delivery.deliveryAgentAssigned === "boolean"
        ? delivery.deliveryAgentAssigned
        : null,
    pendingTaskCount: Math.max(0, Math.trunc(delivery.pendingTaskCount)),
    totalTaskCount: Math.max(0, Math.trunc(delivery.totalTaskCount)),
    tasks: delivery.tasks
      .slice(0, 64)
      .map((task) => ({
        id: optionalString(task.id, 100) ?? "unknown",
        title: optionalString(task.title, 160) ?? optionalString(task.id, 100) ?? "Task",
        complete: task.complete === true,
        enabled: task.enabled === true,
        required: task.required === true,
        order:
          typeof task.order === "number" && Number.isFinite(task.order)
            ? task.order
            : null,
      })),
  };
}

export class OrderIdentity {
  readonly #hmacKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error("OrderIdentity requires the 32-byte token encryption key");
    }
    this.#hmacKey = Buffer.from(
      hkdfSync(
        "sha256",
        masterKey,
        Buffer.from("OrderPulse order identity salt", "utf8"),
        Buffer.from("order-reference-hmac-v1", "utf8"),
        32,
      ),
    );
  }

  normalize(order: TeslaOrder): TrackedOrder | null {
    const referenceNumber = optionalString(order.referenceNumber, 1_024);
    const vehicleMapId =
      typeof order.vehicleMapId === "number" && Number.isFinite(order.vehicleMapId)
        ? String(order.vehicleMapId)
        : null;
    const identity = referenceNumber
      ? `reference:${referenceNumber}`
      : vehicleMapId
        ? `vehicle-map:${vehicleMapId}`
        : null;
    if (!identity) return null;

    return {
      orderKey: createHmac("sha256", this.#hmacKey).update(identity, "utf8").digest("base64url"),
      referenceSuffix: referenceNumber ? referenceNumber.slice(-4) : null,
      orderStatus: optionalString(order.orderStatus),
      orderSubstatus: optionalString(order.orderSubstatus),
      modelCode: optionalString(order.modelCode),
      marketOptions: normalizedMarketOptions(order.mktOptions),
      delivery: normalizeDelivery(order),
    };
  }
}
