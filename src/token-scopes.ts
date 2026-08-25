import { decodeJwt } from "jose";
import type { TeslaTokenResponse } from "./types.js";

function normalizeScopes(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? value.split(/\s+/)
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  return [...new Set(raw.map((scope) => scope.trim()).filter(Boolean))];
}

export function accessTokenScopes(accessToken: string): string[] {
  try {
    // This claim is diagnostic only. Authorization remains enforced by Tesla's API.
    const claims = decodeJwt(accessToken);
    return normalizeScopes(claims.scp ?? claims.scope);
  } catch {
    // Preserve compatibility if Tesla ever returns an opaque access token.
    return [];
  }
}

export function grantedScopes(tokens: TeslaTokenResponse, fallback = ""): string {
  const responseScopes = normalizeScopes(tokens.scope);
  if (responseScopes.length > 0) {
    return responseScopes.join(" ");
  }

  const decodedScopes = accessTokenScopes(tokens.access_token);
  if (decodedScopes.length > 0) {
    return decodedScopes.join(" ");
  }

  return normalizeScopes(fallback).join(" ");
}
