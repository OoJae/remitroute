// Encrypt execution-wallet private keys at rest. The ciphertext is stored in
// users.wallet_key_ref. Plaintext keys never touch the repo or the database.
// AES-256-GCM with a per-record random IV. Key from config.ENCRYPTION_KEY.
//
// The reference is versioned: "v<N>.iv.tag.cipher". Decrypt also accepts the
// legacy 3-part "iv.tag.cipher" (treated as v1) and, during a key rotation,
// falls back to ENCRYPTION_KEY_PREVIOUS so old ciphertext still reads until
// rotate-encryption-key.ts has re-encrypted every row.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";

function keyFromHex(hex: string | undefined, label: string): Buffer {
  if (!hex || hex.length !== 64) {
    throw new Error(`${label} must be 32 bytes hex (64 chars). Generate with: openssl rand -hex 32`);
  }
  return Buffer.from(hex, "hex");
}

function currentKey(): Buffer {
  return keyFromHex(config.ENCRYPTION_KEY, "ENCRYPTION_KEY");
}

// Returns a versioned reference: v<N>.ivHex.tagHex.cipherHex
export function encryptKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, currentKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    `v${config.ENCRYPTION_KEY_VERSION}`,
    iv.toString("hex"),
    tag.toString("hex"),
    enc.toString("hex"),
  ].join(".");
}

function decryptWith(key: Buffer, ivHex: string, tagHex: string, cipherHex: string): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

export function decryptKey(ref: string): string {
  const parts = ref.split(".");
  // Accept legacy "iv.tag.cipher" (3 parts) and versioned "v<N>.iv.tag.cipher" (4).
  const [ivHex, tagHex, cipherHex] =
    parts.length === 4 ? (parts.slice(1) as [string, string, string])
    : parts.length === 3 ? (parts as [string, string, string])
    : (() => {
        throw new Error("Malformed wallet_key_ref");
      })();

  try {
    return decryptWith(currentKey(), ivHex, tagHex, cipherHex);
  } catch (err) {
    // During rotation, old rows are still under the previous key.
    if (config.ENCRYPTION_KEY_PREVIOUS) {
      return decryptWith(
        keyFromHex(config.ENCRYPTION_KEY_PREVIOUS, "ENCRYPTION_KEY_PREVIOUS"),
        ivHex,
        tagHex,
        cipherHex,
      );
    }
    throw err;
  }
}
