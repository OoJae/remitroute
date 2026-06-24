// Server-side (Node) authentication helpers: nonce issuance/consumption,
// MiniPay signature verification, and session minting/reading. The Edge-safe
// token signing lives in shared/session.ts; this module adds the DB + viem +
// config pieces that only run in Node route handlers (never in middleware).
import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "./db/client.js";
import { authNonces, users } from "./db/schema.js";
import { publicClient } from "./viem.js";
import { config } from "./config.js";
import { log } from "./log.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
  type Session,
} from "./session.js";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function sessionSecret(): string {
  const s = config.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set (>=32 chars) for authentication");
  }
  return s;
}

// The message the wallet signs. Includes a single-use nonce and the domain so a
// signature for one site cannot be replayed at another.
export function buildSignMessage(address: string, nonce: string): string {
  const domain = new URL(config.APP_BASE_URL).host;
  return [
    `${domain} wants you to sign in with your account:`,
    getAddress(address),
    "",
    "Sign in to RemitRoute. This request will not trigger a transaction or cost gas.",
    "",
    `Nonce: ${nonce}`,
  ].join("\n");
}

// Issue a fresh single-use nonce for an address and return the message to sign.
export async function createNonce(address: string): Promise<{ nonce: string; message: string }> {
  const addr = getAddress(address).toLowerCase();
  const nonce = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  await db.insert(authNonces).values({ address: addr, nonce, expiresAt });
  // Opportunistic cleanup of expired nonces (cheap, keeps the table small).
  await db.delete(authNonces).where(lt(authNonces.expiresAt, new Date())).catch(() => {});
  return { nonce, message: buildSignMessage(address, nonce) };
}

// Atomically consume a nonce: it must exist for this address, be unused, and not
// be expired. Marks it used and returns true exactly once.
export async function consumeNonce(address: string, nonce: string): Promise<boolean> {
  const addr = getAddress(address).toLowerCase();
  const updated = await db
    .update(authNonces)
    .set({ used: true })
    .where(
      and(
        eq(authNonces.nonce, nonce),
        eq(authNonces.address, addr),
        eq(authNonces.used, false),
        gt(authNonces.expiresAt, new Date()),
      ),
    )
    .returning();
  return updated.length === 1;
}

// Verify a personal_sign signature. Uses publicClient.verifyMessage so MiniPay
// smart-contract wallets (ERC-1271) verify, not just plain EOAs.
export async function verifyWalletSignature(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    return await publicClient.verifyMessage({
      address: getAddress(address),
      message,
      signature: signature as `0x${string}`,
    });
  } catch (err) {
    log.warn({ err }, "signature verification threw");
    return false;
  }
}

// Mint a signed session token bound to userId + address.
export async function mintSession(userId: string, address: string): Promise<string> {
  const session: Session = {
    userId,
    addr: getAddress(address).toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  return signSession(session, sessionSecret());
}

// Read and verify the session cookie from an incoming request.
export async function getSessionUser(request: Request): Promise<Session | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]!), sessionSecret());
}

// In a route handler, the middleware has already verified the session and set
// x-user-id. Trust that header (middleware strips any client-supplied copy).
export function userIdFromHeaders(request: Request): string | null {
  return request.headers.get("x-user-id");
}

// Look up the full user row for the authenticated principal, or null.
export async function authedUser(request: Request) {
  const userId = userIdFromHeaders(request);
  if (!userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
