// Signed, short-lived Telegram link codes. The Mini App hands the user a
// t.me/<bot>?start=<code> deep link; when the bot receives /start <code> we
// verify the code and bind that chat to the user. Telegram's start payload
// allows only [A-Za-z0-9_-] and at most 64 chars, so the code is fixed-width
// hex: 32 (userId XOR a per-expiry keystream) + 8 (expiry, unix seconds) + 20
// (HMAC-SHA256 over the obfuscated id + expiry, truncated) = 60 chars. The
// internal user PK is never printed in the clear (keystream-obfuscated); the
// HMAC over SESSION_SECRET is what actually authorizes the bind. Stateless.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

// Short TTL: the deep link opens Telegram immediately and /start is one tap, so
// a few minutes is ample and shrinks the replay window for a leaked live code.
const CODE_TTL_SECONDS = 3 * 60;
const SIG_HEX_CHARS = 20;

function secret(): string {
  if (!config.SESSION_SECRET) throw new Error("SESSION_SECRET required for telegram link codes");
  return config.SESSION_SECRET;
}

function sign(obfHex: string, expHex: string): string {
  return createHmac("sha256", secret())
    .update(`tglink|${obfHex}|${expHex}`)
    .digest("hex")
    .slice(0, SIG_HEX_CHARS);
}

// 16-byte keystream bound to the expiry, so the same user gets a different
// obfuscated blob each code without any stored state.
function keystream(expHex: string): Buffer {
  return createHmac("sha256", secret()).update(`tgkdf|${expHex}`).digest().subarray(0, 16);
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!;
  return out;
}

export function makeLinkCode(userId: string, nowMs = Date.now()): string {
  const userIdHex = userId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(userIdHex)) throw new Error("userId must be a uuid");
  const exp = Math.floor(nowMs / 1000) + CODE_TTL_SECONDS;
  const expHex = exp.toString(16).padStart(8, "0");
  const obfHex = xor(Buffer.from(userIdHex, "hex"), keystream(expHex)).toString("hex");
  return `${obfHex}${expHex}${sign(obfHex, expHex)}`;
}

// Returns the userId (uuid form) or null for anything invalid, expired, or
// tampered with. The HMAC is verified in constant time before the id is
// recovered, so only codes we minted ever decrypt.
export function verifyLinkCode(code: string, nowMs = Date.now()): string | null {
  if (!/^[0-9a-f]{60}$/.test(code)) return null;
  const obfHex = code.slice(0, 32);
  const expHex = code.slice(32, 40);
  const sig = code.slice(40);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(sign(obfHex, expHex), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(expHex, 16) * 1000 < nowMs) return null;
  const userIdHex = xor(Buffer.from(obfHex, "hex"), keystream(expHex)).toString("hex");
  return `${userIdHex.slice(0, 8)}-${userIdHex.slice(8, 12)}-${userIdHex.slice(12, 16)}-${userIdHex.slice(16, 20)}-${userIdHex.slice(20)}`;
}
