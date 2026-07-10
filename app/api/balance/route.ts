// Returns the user's execution-wallet money picture for the Mini App: idle
// token balances (with USD values), the live Aave yield positions (supplied,
// current APY, interest earned so far), and a USD total. Read-only. The user is
// the authenticated principal (x-user-id, set by middleware from the session).
import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../../shared/db/client.js";
import { users, executions } from "../../../shared/db/schema.js";
import { executionWalletBalances } from "../../../shared/balances.js";
import { aavePositions } from "../../../shared/aave.js";
import { usdValueOf } from "../../../shared/usdValue.js";
import { netContributed, earnedApprox } from "../../../shared/yieldMath.js";
import { log } from "../../../shared/log.js";
import type { Hex } from "../../../shared/addresses.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WITHDRAW_TOKENS = ["cUSD", "USDC", "cEUR"];

// Interest earned so far for one asset: current supplied balance minus the net
// contributions replayed from this user's own ledger (approximate; a "max"
// withdrawal resets the baseline). Never throws into the response.
async function earnedFor(userId: string, symbol: string, suppliedNow: number): Promise<number> {
  const rows = await db
    .select({ kind: executions.kind, status: executions.status, amountIn: executions.amountIn })
    .from(executions)
    .where(
      and(
        eq(executions.userId, userId),
        eq(executions.tokenIn, symbol),
        inArray(executions.kind, ["savings_sweep", "yield_withdraw"]),
      ),
    )
    .orderBy(asc(executions.createdAt));
  const net = netContributed(rows);
  return earnedApprox(suppliedNow, net);
}

export async function GET(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  const balances = await executionWalletBalances(user.walletAddress, WITHDRAW_TOKENS);

  // USD value per idle token (1:1 for USD stables, Mento quote otherwise;
  // usdValueOf falls back to the nominal amount rather than failing).
  const withUsd = await Promise.all(
    balances.map(async (b) => ({
      ...b,
      usd: Number(b.amount) > 0 ? await usdValueOf(b.symbol, b.amount) : 0,
    })),
  );

  // Live yield positions with earned-so-far. A failure here degrades to an
  // empty list rather than breaking the balance view.
  let yieldPositions: Array<{ symbol: string; supplied: string; apyPct: number; earned: number; usd: number }> = [];
  try {
    const positions = await aavePositions(user.walletAddress as Hex);
    yieldPositions = await Promise.all(
      positions.map(async (p) => ({
        symbol: p.symbol,
        supplied: p.supplied,
        apyPct: p.apyPct,
        earned: await earnedFor(userId, p.symbol, p.suppliedNum),
        usd: await usdValueOf(p.symbol, p.supplied),
      })),
    );
  } catch (err) {
    log.warn({ err, userId }, "yield position read failed; returning balances only");
  }

  const totalUsd =
    withUsd.reduce((a, b) => a + b.usd, 0) + yieldPositions.reduce((a, p) => a + p.usd, 0);

  return NextResponse.json({
    wallet: user.walletAddress,
    balances: withUsd,
    yield: yieldPositions,
    totalUsd,
  });
}
