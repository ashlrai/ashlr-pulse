/**
 * token-crypto.ts — symmetric encryption for OAuth access tokens at rest.
 *
 * Uses Node's crypto (AES-256-GCM) to wrap the GitHub access token before
 * it lands in Postgres. Postgres stores raw bytes; we never store the
 * plaintext or the IV separately — the GCM ciphertext + tag + IV are
 * concatenated into one blob, then stored as bytea.
 *
 * Format on disk (one bytea):
 *   [ 12 bytes IV ][ 16 bytes auth tag ][ N bytes ciphertext ]
 *
 * Key: PULSE_TOKEN_ENC_KEY env var. Must be 32 bytes hex-encoded
 * (`openssl rand -hex 32`). Loaded at module init; missing → throws on
 * first encrypt/decrypt call (dev mode tolerates fallback for local PAT
 * mint flows that don't touch GitHub tokens).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  const hex = process.env.PULSE_TOKEN_ENC_KEY;
  if (!hex) {
    throw new Error(
      "PULSE_TOKEN_ENC_KEY is not set — generate with `openssl rand -hex 32` and add to env",
    );
  }
  if (hex.length !== 64) {
    throw new Error("PULSE_TOKEN_ENC_KEY must be 32 bytes hex (64 chars)");
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt a UTF-8 string. Returns a single Buffer ready for bytea. */
export function encryptToken(plain: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Decrypt a Buffer (typically a Postgres bytea row) back to UTF-8. */
export function decryptToken(blob: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("token-crypto: ciphertext too short");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}
