// Encrypt execution-wallet private keys at rest. The ciphertext is stored in
// users.wallet_key_ref. Plaintext keys never touch the repo or the database.
// AES-256-GCM with a per-record random IV. Key from config.ENCRYPTION_KEY (32-byte hex).
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";

function encryptionKey(): Buffer {
  const hex = config.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be 32 bytes hex (64 chars). Generate with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

// Returns a compact reference string: ivHex.tagHex.cipherHex
export function encryptKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(".");
}

export function decryptKey(ref: string): string {
  const parts = ref.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed wallet_key_ref");
  }
  const [ivHex, tagHex, cipherHex] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
