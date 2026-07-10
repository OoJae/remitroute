// Signed, short-lived Telegram link codes. The Mini App hands the user a
// t.me/<bot>?start=<code> deep link; when the bot receives /start <code> we
// verify the code and bind that chat to the user. Telegram's start payload
// allows only [A-Za-z0-9_-] and at most 64 characters, so the code is a
// fixed-width hex string: 32 (userId, uuid without dashes) + 8 (expiry, unix
// seconds) + 20 (HMAC-SHA256 over the first two fields, truncated) = 60 chars.
// Signed with SESSION_SECRET; no server-side state to store or clean up.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const CODE_TTL_SECONDS = 15 * 60;
const SIG_HEX_CHARS = 20;

function secret(): string {
  if (!config.SESSION_SECRET) throw new Error("SESSION_SECRET required for telegram link codes");
  return config.SESSION_SECRET;
}

function sign(userIdHex: string, expHex: string): string {
  return createHmac("sha256", secret())
    .update(`tglink|${userIdHex}|${expHex}`)
    .digest("hex")
    .slice(0, SIG_HEX_CHARS);
}

export function makeLinkCode(userId: string, nowMs = Date.now()): string {
  const userIdHex = userId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(userIdHex)) throw new Error("userId must be a uuid");
  const exp = Math.floor(nowMs / 1000) + CODE_TTL_SECONDS;
  const expHex = exp.toString(16).padStart(8, "0");
  return `${userIdHex}${expHex}${sign(userIdHex, expHex)}`;
}

// Returns the userId (uuid form) or null for anything invalid, expired, or
// tampered with. Constant-time signature comparison.
export function verifyLinkCode(code: string, nowMs = Date.now()): string | null {
  if (!/^[0-9a-f]{60}$/.test(code)) return null;
  const userIdHex = code.slice(0, 32);
  const expHex = code.slice(32, 40);
  const sig = code.slice(40);
  const expected = sign(userIdHex, expHex);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(expHex, 16) * 1000 < nowMs) return null;
  return `${userIdHex.slice(0, 8)}-${userIdHex.slice(8, 12)}-${userIdHex.slice(12, 16)}-${userIdHex.slice(16, 20)}-${userIdHex.slice(20)}`;
}
