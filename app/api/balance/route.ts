// Returns the idle token balances of a user's execution wallet, for the Mini App
// balance view and to populate the withdraw "Max". Read-only.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";
import { executionWalletBalances } from "../../../shared/balances.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WITHDRAW_TOKENS = ["cUSD", "USDC", "cEUR"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = z.string().uuid().safeParse(url.searchParams.get("user"));
  if (!parsed.success) {
    return NextResponse.json({ error: "user query param must be a uuid" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, parsed.data));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  const balances = await executionWalletBalances(user.walletAddress, WITHDRAW_TOKENS);
  return NextResponse.json({ wallet: user.walletAddress, balances });
}
