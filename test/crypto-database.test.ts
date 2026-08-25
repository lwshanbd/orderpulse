import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SecretBox } from "../src/crypto.js";
import { OrderPulseDatabase } from "../src/database.js";

test("SecretBox encrypts and authenticates values", () => {
  const box = new SecretBox(randomBytes(32));
  const encrypted = box.encrypt("highly-sensitive-token");

  assert.notEqual(encrypted, "highly-sensitive-token");
  assert.equal(box.decrypt(encrypted), "highly-sensitive-token");

  const parts = encrypted.split(":");
  const ciphertext = parts.at(-1);
  assert.ok(ciphertext);
  parts[parts.length - 1] = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
  assert.throws(() => box.decrypt(parts.join(":")));
});

test("database stores OAuth nonces and Tesla tokens as ciphertext", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-db-"));
  const databasePath = join(directory, "orderpulse.sqlite");
  const database = new OrderPulseDatabase(databasePath, new SecretBox(randomBytes(32)));

  database.createOAuthTransaction({ state: "state-value", nonce: "nonce-value", createdAt: Date.now() });
  database.saveTeslaTokens({
    tokens: {
      access_token: "plain-access-token",
      refresh_token: "plain-refresh-token",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid offline_access user_data vehicle_device_data",
    },
    fleetBaseUrl: "https://fleet-api.prd.na.vn.cloud.tesla.com",
    subject: "subject",
  });

  const stored = database.loadTeslaTokens();
  assert.equal(stored?.accessToken, "plain-access-token");
  assert.equal(stored?.refreshToken, "plain-refresh-token");
  database.close();

  const rawDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const oauthRow = rawDatabase.prepare("SELECT nonce_ciphertext FROM oauth_transactions").get() as
    | { nonce_ciphertext: string }
    | undefined;
  const tokenRow = rawDatabase
    .prepare("SELECT access_ciphertext, refresh_ciphertext FROM tesla_tokens")
    .get() as { access_ciphertext: string; refresh_ciphertext: string } | undefined;
  rawDatabase.close();

  assert.ok(oauthRow);
  assert.ok(tokenRow);
  assert.doesNotMatch(oauthRow.nonce_ciphertext, /nonce-value/);
  assert.doesNotMatch(tokenRow.access_ciphertext, /plain-access-token/);
  assert.doesNotMatch(tokenRow.refresh_ciphertext, /plain-refresh-token/);
});

test("OAuth state is one-time and expires", () => {
  const directory = mkdtempSync(join(tmpdir(), "orderpulse-state-"));
  const database = new OrderPulseDatabase(
    join(directory, "orderpulse.sqlite"),
    new SecretBox(randomBytes(32)),
  );

  database.createOAuthTransaction({ state: "once", nonce: "nonce", createdAt: Date.now() });
  assert.equal(database.consumeOAuthTransaction("once", 600)?.nonce, "nonce");
  assert.equal(database.consumeOAuthTransaction("once", 600), null);

  database.createOAuthTransaction({
    state: "expired",
    nonce: "nonce",
    createdAt: Date.now() - 2_000,
  });
  assert.equal(database.consumeOAuthTransaction("expired", 1), null);
  database.close();
});
