// Savings-goal queries shared by the goals API and the engine's lock gate.
// Progress is replayed from the execution ledger (USD-valued contributions of
// the goal's own savings_sweep schedule since the goal was created), so the
// number the user sees and the number the lock enforces are the same.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { executions, goals } from "./db/schema.js";

export interface GoalWithProgress {
  id: string;
  scheduleId: string | null;
  name: string;
  asset: string;
  targetUsd: number;
  progressUsd: number;
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
    .where(and(eq(goals.userId, userId), inArray(goals.status, ["active", "completed"])));
  return Promise.all(
    rows.map(async (g) => ({
      id: g.id,
      scheduleId: g.scheduleId,
      name: g.name,
      asset: g.asset,
      targetUsd: Number(g.targetUsd),
      progressUsd: await progressFor(g),
      targetDate: g.targetDate,
      lockUntil: g.lockUntil,
      status: g.status,
      createdAt: g.createdAt,
    })),
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
    lockedUsd += Math.min(progress, Number(g.targetUsd));
    if (!earliestUnlock || g.lockUntil < earliestUnlock) earliestUnlock = g.lockUntil;
  }
  return { lockedUsd, earliestUnlock };
}
