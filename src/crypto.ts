import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const FORMAT_VERSION = "v1";
const IV_LENGTH = 12;

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("SecretBox requires a 32-byte key");
    }
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":");
  }

  decrypt(value: string): string {
    const parts = value.split(":");
    if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
      throw new Error("Unsupported encrypted value format");
    }

    const iv = Buffer.from(parts[1] ?? "", "base64url");
    const tag = Buffer.from(parts[2] ?? "", "base64url");
    const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
    if (iv.length !== IV_LENGTH || tag.length !== 16) {
      throw new Error("Invalid encrypted value metadata");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class MobileCredentials {
  readonly #hmacKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error("MobileCredentials requires a 32-byte master key");
    }
    this.#hmacKey = Buffer.from(
      hkdfSync(
        "sha256",
        masterKey,
        Buffer.from("OrderPulse mobile credentials salt", "utf8"),
        Buffer.from("mobile-credential-hmac-v1", "utf8"),
        32,
      ),
    );
  }

  createPairingCode(): string {
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const bytes = randomBytes(8);
    const characters = [...bytes].map((value) => alphabet[value % alphabet.length]);
    return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
  }

  normalizePairingCode(value: string): string {
    return value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "");
  }

  createAccessToken(): string {
    return randomBase64Url(32);
  }

  hash(value: string): string {
    return createHmac("sha256", this.#hmacKey).update(value, "utf8").digest("base64url");
  }
}
