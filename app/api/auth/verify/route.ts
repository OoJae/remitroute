// Step 2 of sign-in: verify the signed nonce, find-or-create the user (this
// replaces the old unauthenticated onboard), and mint an HttpOnly session
// cookie. Proving control of the MiniPay address is now required before any
// userId is issued, closing the address -> userId enumeration hole.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAddress, isAddress } from "viem";
import { db } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { createExecutionWallet } from "../../../../shared/wallet.js";
import {
  buildSignMessage,
  consumeNonce,
  mintSession,
  verifyWalletSignature,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../../../../shared/auth.js";
import { rateLimit, clientIp } from "../../../../shared/ratelimit.js";
import { log } from "../../../../shared/log.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const rl = await rateLimit(`auth-verify:${clientIp(request)}`);
  if (!rl.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const body = (await request.json().catch(() => null)) as
    | { minipayAddress?: string; nonce?: string; signature?: string }
    | null;
  if (!body || !isAddress(body.minipayAddress ?? "") || !body.nonce || !body.signature) {
    return NextResponse.json(
      { error: "minipayAddress, nonce and signature are required" },
      { status: 400 },
    );
  }
  const address = getAddress(body.minipayAddress!);

  // Consume the nonce first (single-use), then verify the signature.
  if (!(await consumeNonce(address, body.nonce))) {
    return NextResponse.json({ error: "invalid or expired nonce" }, { status: 401 });
  }
  const message = buildSignMessage(address, body.nonce);
  if (!(await verifyWalletSignature(address, message, body.signature))) {
    return NextResponse.json({ error: "signature did not verify" }, { status: 401 });
  }

  // Find or create the user keyed by the proven address.
  let [user] = await db.select().from(users).where(eq(users.minipayAddress, address));
  if (!user) {
    const wallet = createExecutionWallet();
    await db
      .insert(users)
      .values({ minipayAddress: address, walletAddress: wallet.address, walletKeyRef: wallet.keyRef })
      .onConflictDoNothing({ target: users.minipayAddress });
    [user] = await db.select().from(users).where(eq(users.minipayAddress, address));
  }
  if (!user) {
    return NextResponse.json({ error: "could not establish user" }, { status: 500 });
  }

  const token = await mintSession(user.id, address);
  log.info({ userId: user.id }, "session established");
  const res = NextResponse.json({
    userId: user.id,
    executionWallet: user.walletAddress,
    city: user.city,
    displayName: user.displayName,
    telegramLinked: Boolean(user.telegramId),
  });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
