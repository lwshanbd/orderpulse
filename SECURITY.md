# OrderPulse security notes

- Tesla access tokens, rotating refresh tokens, and OAuth nonces are encrypted with AES-256-GCM before SQLite persistence.
- Production refuses secrets supplied directly as environment values. Docker Compose mounts secret files under `/run/secrets`.
- The OAuth callback is public by design, but its random `state` is single-use and expires after ten minutes. The ID token is verified against Tesla's JWKS, including issuer, audience, and nonce.
- Only `openid offline_access user_data vehicle_device_data` scopes are accepted. Order access requires vehicle information, while vehicle command, charging-command, and location scopes are intentionally rejected by configuration validation.
- Administrative endpoints use HTTPS plus Basic Authentication and a small in-memory failed-login limiter. Requests without an Authorization header are not treated as password failures, and a correct password clears an existing IP block. Port 8787 is bound only to NAS loopback.
- Order output is allow-listed and masks RN/VIN values. The schema endpoint returns field names and types, never raw values.
- Order snapshots never persist the complete RN. A key-separated HMAC provides a stable order identifier, while only the last four characters are retained for display.
- A failed or structurally unidentifiable Tesla response cannot alter snapshots. Missing orders require three consecutive successful polls before becoming inactive.
- Background polling is disabled by default and must be enabled explicitly after a Tesla billing limit is configured.
- Application request logging is disabled so OAuth callback parameters and authorization headers are not written by OrderPulse. Reverse-proxy access-log policy remains a NAS responsibility.
- Back up `data/orderpulse.sqlite` together with `secrets/token_encryption_key.txt`. Without the exact encryption key, the saved Tesla authorization cannot be recovered.
- Never commit the `secrets/`, `data/`, `.env`, private key, access token, or refresh token files.
- The future iOS app must use per-device credentials; the administrative Basic Auth password must never be embedded in an app bundle.
