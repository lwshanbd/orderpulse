# OrderPulse security notes

- Fleet API and Owner API access/refresh tokens, PKCE verifiers, and OAuth nonces are encrypted with AES-256-GCM before SQLite persistence.
- Production refuses secrets supplied directly as environment values. Docker Compose mounts secret files under `/run/secrets`.
- The Fleet OAuth callback is public by design, but its random `state` is single-use and expires after ten minutes. The ID token is verified against Tesla's JWKS, including issuer, audience, and nonce.
- Rich delivery details use a separate personal Owner authorization with PKCE. OrderPulse accepts only the exact `tesla://auth/callback` scheme/host/path, consumes `state` once within one hour, never receives the Tesla password or MFA code, and encrypts the resulting tokens on the NAS.
- Owner traffic is hard-coded to Tesla's authentication, owner-order, and delivery-task hosts. It performs only GET requests after token exchange/refresh; it cannot proxy arbitrary URLs or send vehicle commands.
- Only `openid offline_access user_data vehicle_device_data` scopes are accepted. Order access requires vehicle information, while vehicle command, charging-command, and location scopes are intentionally rejected by configuration validation.
- Administrative endpoints use HTTPS plus Basic Authentication and a small in-memory failed-login limiter. Requests without an Authorization header are not treated as password failures, and a correct password clears an existing IP block. Port 8787 is bound only to NAS loopback.
- Order and delivery output is allow-listed. Full RN values are never persisted, VIN and license plate values are masked, and task free-form content/targets are discarded. Schema endpoints return field names and types, never raw values.
- Order snapshots never persist the complete RN. A key-separated HMAC provides a stable order identifier, while only the last four characters are retained for display.
- A failed or structurally unidentifiable Tesla response cannot alter snapshots. Missing orders require three consecutive successful polls before becoming inactive.
- Background polling is disabled by default and must be enabled explicitly after a Tesla billing limit is configured.
- Application request logging is disabled so OAuth callback parameters and authorization headers are not written by OrderPulse. Reverse-proxy access-log policy remains a NAS responsibility.
- Back up `data/orderpulse.sqlite` together with `secrets/token_encryption_key.txt`. Without the exact encryption key, the saved Tesla authorization cannot be recovered.
- Never commit the `secrets/`, `data/`, `.env`, private key, access token, or refresh token files.
- The iOS app uses per-device credentials; the administrative Basic Auth password and both Tesla authorizations are never embedded in the app bundle.
- A paired iPhone may initiate the one-time Owner PKCE flow, but receives neither the resulting access token nor refresh token; the callback code is sent only to the paired NAS over HTTPS and immediately consumed.
