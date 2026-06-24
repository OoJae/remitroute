// Returns the idle token balances of a user's execution wallet, for the Mini App
// balance view and to populate the withdraw "Max". Read-only. The user is the
// authenticated principal (x-user-id, set by middleware from the session).
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";
import { executionWalletBalances } from "../../../shared/balances.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WITHDRAW_TOKENS = ["cUSD", "USDC", "cEUR"];

export async function GET(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  const balances = await executionWalletBalances(user.walletAddress, WITHDRAW_TOKENS);
  return NextResponse.json({ wallet: user.walletAddress, balances });
}
