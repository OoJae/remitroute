// Savings-goal queries shared by the goals API and the engine's lock gate.
// Contributions are replayed from the execution ledger (USD-valued sweeps of the
// goal's own schedule since it was created). The LOCK enforces on that replayed
// figure (a market dip must never unlock funds), while the DISPLAYED progress is
// additionally capped at the live Aave position so the card never shows savings
// that have since been withdrawn as still saved.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { executions, goals, users } from "./db/schema.js";
import { aavePositions } from "./aave.js";
import { usdValueOf } from "./usdValue.js";
import { lockBreached, goalLockedUsd } from "./goalMath.js";
import { log } from "./log.js";
import type { Hex } from "./addresses.js";

export { lockBreached, goalLockedUsd };

export interface GoalWithProgress {
  id: string;
  scheduleId: string | null;
  name: string;
  asset: string;
  targetUsd: number;
  progressUsd: number;
  reached: boolean;
  targetDate: Date | null;
  lockUntil: Date | null;
  status: string;
  createdAt: Date | null;
}

async function progressFor(goal: {
  scheduleId: string | null;
  createdAt: Date | null;
}): Promise<number> {
  if (!goal.scheduleId) return 0;
  const filters = [
    eq(executions.scheduleId, goal.scheduleId),
    inArray(executions.status, ["confirmed", "success"]),
  ];
  if (goal.createdAt) filters.push(gte(executions.createdAt, goal.createdAt));
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${executions.usdValue}, ${executions.amountIn})), 0)::float8`,
    })
    .from(executions)
    .where(and(...filters));
  return row?.total ?? 0;
}

export async function listGoalsWithProgress(userId: string): Promise<GoalWithProgress[]> {
  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")));

  // Live USD value of the user's Aave position per asset, to cap the displayed
  // progress. Best-effort: if the position read fails, fall back to the
  // uncapped replayed figure rather than showing zero.
  const positionUsd = new Map<string, number>();
  try {
    const [user] = await db.select({ wallet: users.walletAddress }).from(users).where(eq(users.id, userId));
    if (user) {
      const positions = await aavePositions(user.wallet as Hex);
      for (const p of positions) positionUsd.set(p.symbol, await usdValueOf(p.symbol, p.supplied));
    }
  } catch (err) {
    log.warn({ err, userId }, "goal progress: live position read failed; showing replayed figure");
  }

  return Promise.all(
    rows.map(async (g) => {
      const replayed = await progressFor(g);
      const cap = positionUsd.has(g.asset) ? positionUsd.get(g.asset)! : Infinity;
      const progressUsd = Math.min(replayed, cap);
      return {
        id: g.id,
        scheduleId: g.scheduleId,
        name: g.name,
        asset: g.asset,
        targetUsd: Number(g.targetUsd),
        progressUsd,
        reached: replayed >= Number(g.targetUsd),
        targetDate: g.targetDate,
        lockUntil: g.lockUntil,
        status: g.status,
        createdAt: g.createdAt,
      };
    }),
  );
}

export interface LockSummary {
  lockedUsd: number;
  earliestUnlock: Date | null;
}

// USD value the user's active locked goals protect for one asset: for each
// goal whose lock is still in the future, the smaller of its progress and its
// target (the lock covers what the goal has actually accumulated, up to the
// target; anything above that stays freely withdrawable).
export async function lockedUsdFor(userId: string, asset: string): Promise<LockSummary> {
  const now = new Date();
  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active"), eq(goals.asset, asset)));
  let lockedUsd = 0;
  let earliestUnlock: Date | null = null;
  for (const g of rows) {
    if (!g.lockUntil || g.lockUntil <= now) continue;
    const progress = await progressFor(g);
    lockedUsd += goalLockedUsd(progress, Number(g.targetUsd));
    if (!earliestUnlock || g.lockUntil < earliestUnlock) earliestUnlock = g.lockUntil;
  }
  return { lockedUsd, earliestUnlock };
}
