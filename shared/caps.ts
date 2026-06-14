// Daily spend caps. Every money-moving script calls checkCaps before sending.
// Caps are USD-equivalent whole units; for the hackathon we treat stablecoin
// amounts as roughly 1:1 with USD, which is correct for cUSD and USDC and a safe
// upper bound for local-currency legs (they are smaller in USD terms).
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { executions } from "./db/schema.js";
import { config } from "./config.js";

export interface CapDecision {
  allowed: boolean;
  reason?: string;
  userSpentToday: number;
  globalSpentToday: number;
  perUserCap: number;
  globalCap: number;
  perTxCap: number;
}

// Sum amount_in for successful or pending sends since midnight UTC. Dry runs do
// not count against caps. A row counts if its status is not a failure or dry run.
const COUNTED_STATUSES = ["sent", "confirmed", "success"] as const;

async function sumSince(userId?: string): Promise<number> {
  const startOfDay = sql`date_trunc('day', now())`;
  const filters = [
    gte(executions.createdAt, startOfDay as never),
    sql`${executions.status} in ('sent','confirmed','success')`,
  ];
  if (userId) filters.push(eq(executions.userId, userId));

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${executions.amountIn}), 0)::float8` })
    .from(executions)
    .where(and(...filters));
  return row?.total ?? 0;
}

// Check whether adding `amount` for `userId` stays within both caps.
export async function checkCaps(userId: string, amount: number): Promise<CapDecision> {
  const [userSpentToday, globalSpentToday] = await Promise.all([
    sumSince(userId),
    sumSince(),
  ]);

  const perUserCap = config.PER_USER_DAILY_CAP;
  const globalCap = config.GLOBAL_DAILY_CAP;
  const perTxCap = config.PER_TX_CAP;

  const base = { userSpentToday, globalSpentToday, perUserCap, globalCap, perTxCap };

  // Per-transaction cap: no single action may exceed it, independent of the
  // daily totals.
  if (amount > perTxCap) {
    return {
      allowed: false,
      reason: `per-transaction cap exceeded (${amount} > ${perTxCap})`,
      ...base,
    };
  }

  if (userSpentToday + amount > perUserCap) {
    return {
      allowed: false,
      reason: `per-user daily cap reached (${userSpentToday} + ${amount} > ${perUserCap})`,
      ...base,
    };
  }
  if (globalSpentToday + amount > globalCap) {
    return {
      allowed: false,
      reason: `global daily cap reached (${globalSpentToday} + ${amount} > ${globalCap})`,
      ...base,
    };
  }
  return { allowed: true, ...base };
}

export { COUNTED_STATUSES };
