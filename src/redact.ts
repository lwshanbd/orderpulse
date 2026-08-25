import type { TeslaOrder } from "./types.js";

function maskIdentifier(value: unknown, visibleCharacters: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length <= visibleCharacters) return "•".repeat(value.length);
  return `${"•".repeat(Math.min(value.length - visibleCharacters, 12))}${value.slice(-visibleCharacters)}`;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export interface SanitizedOrder {
  referenceNumber: string | null;
  orderStatus: string | null;
  orderSubstatus: string | null;
  modelCode: string | null;
  vin: string | null;
  marketOptions: string[];
}

export function sanitizeOrder(order: TeslaOrder): SanitizedOrder {
  const rawOptions = order.mktOptions;
  const marketOptions = Array.isArray(rawOptions)
    ? rawOptions.filter((item): item is string => typeof item === "string")
    : typeof rawOptions === "string"
      ? rawOptions.split(",").map((item) => item.trim()).filter(Boolean)
      : [];

  return {
    referenceNumber: maskIdentifier(order.referenceNumber, 4),
    orderStatus: safeString(order.orderStatus),
    orderSubstatus: safeString(order.orderSubstatus),
    modelCode: safeString(order.modelCode),
    vin: maskIdentifier(order.vin, 6),
    marketOptions,
  };
}

type ShapeName = "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined";

function shapeName(value: unknown): ShapeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as ShapeName;
}

export function describeShape(value: unknown, maxDepth = 8): Record<string, ShapeName[]> {
  const paths = new Map<string, Set<ShapeName>>();

  function record(path: string, item: unknown, depth: number): void {
    const key = path || "$";
    const existing = paths.get(key) ?? new Set<ShapeName>();
    existing.add(shapeName(item));
    paths.set(key, existing);
    if (depth >= maxDepth) return;

    if (Array.isArray(item)) {
      for (const child of item.slice(0, 10)) record(`${key}[]`, child, depth + 1);
      return;
    }
    if (typeof item === "object" && item !== null) {
      for (const [childKey, child] of Object.entries(item)) {
        record(path ? `${path}.${childKey}` : childKey, child, depth + 1);
      }
    }
  }

  record("", value, 0);
  return Object.fromEntries(
    [...paths.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, types]) => [path, [...types].sort()]),
  );
}
