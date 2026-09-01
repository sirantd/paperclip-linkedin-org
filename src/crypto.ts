import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope-encrypt OAuth tokens at rest with AES-256-GCM under the configured
 * DEK, so a database read alone never yields a usable LinkedIn token.
 *
 * Wire format: base64( iv(12) || authTag(16) || ciphertext )
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(dekBase64: string): Buffer {
  const key = Buffer.from(dekBase64, "base64");
  if (key.length !== 32) {
    throw new Error(`DEK must decode to exactly 32 bytes, got ${key.length}`);
  }
  return key;
}

export function sealToken(plaintext: string, dekBase64: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadKey(dekBase64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function openToken(sealed: string, dekBase64: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Sealed token is truncated or malformed");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", loadKey(dekBase64), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
