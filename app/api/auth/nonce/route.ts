// Step 1 of sign-in: issue a single-use nonce for the wallet to sign. Public
// (no session yet) but rate-limited per IP.
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { createNonce } from "../../../../shared/auth.js";
import { rateLimit, clientIp } from "../../../../shared/ratelimit.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const rl = await rateLimit(`auth-nonce:${clientIp(request)}`);
  if (!rl.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const body = (await request.json().catch(() => null)) as { minipayAddress?: string } | null;
  if (!body || !isAddress(body.minipayAddress ?? "")) {
    return NextResponse.json({ error: "minipayAddress must be a valid address" }, { status: 400 });
  }
  const { nonce, message } = await createNonce(body.minipayAddress!);
  return NextResponse.json({ nonce, message });
}
