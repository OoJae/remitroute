// Global circuit breaker + per-cycle audit for the heartbeat engine (Phase 11).
// The engine reads the state before moving money and halts on it; a bad cycle
// trips the breaker, which stays halted until an operator clears it.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { engineState, engineCycles, executions } from "./db/schema.js";
import { config } from "./config.js";
import { notify } from "./alerts.js";

const SINGLETON = "singleton";

export interface EngineState {
  status: "running" | "halted";
  haltReason: string | null;
  haltedAt: Date | null;
}

// Read the circuit-breaker state. Treats a missing row as running so the engine
// never blocks on a fresh database.
export async function getEngineState(): Promise<EngineState> {
  const [row] = await db.select().from(engineState).where(eq(engineState.id, SINGLETON));
  if (!row) return { status: "running", haltReason: null, haltedAt: null };
  return {
    status: row.status === "halted" ? "halted" : "running",
    haltReason: row.haltReason ?? null,
    haltedAt: row.haltedAt ?? null,
  };
}

// Trip the breaker. Upserts the singleton so it works even before the seed row,
// and pages the operator (the audit's "alert the operator" used to be log-only).
export async function haltEngine(reason: string): Promise<void> {
  await db
    .insert(engineState)
    .values({ id: SINGLETON, status: "halted", haltReason: reason, haltedAt: new Date(), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: engineState.id,
      set: { status: "halted", haltReason: reason, haltedAt: new Date(), updatedAt: new Date() },
    });
  await notify(`engine HALTED: ${reason}`, { reason });
}

// Clear the breaker (manual operator reset).
export async function resumeEngine(): Promise<void> {
  await db
    .insert(engineState)
    .values({ id: SINGLETON, status: "running", haltReason: null, clearedAt: new Date(), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: engineState.id,
      set: { status: "running", haltReason: null, clearedAt: new Date(), updatedAt: new Date() },
    });
}

export interface CycleRecord {
  cycleId: string;
  gasPass: boolean;
  loaded: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  volume: number;
  aborted: boolean;
}

// Persist a heartbeat cycle to the audit trail.
export async function recordCycle(rec: CycleRecord, halted: boolean): Promise<void> {
  await db.insert(engineCycles).values({
    cycleId: rec.cycleId,
    gasPass: rec.gasPass,
    halted,
    loaded: rec.loaded,
    attempted: rec.attempted,
    succeeded: rec.succeeded,
    failed: rec.failed,
    skipped: rec.skipped,
    volume: String(rec.volume),
    aborted: rec.aborted,
  });
}

// Decide whether a cycle's outcome should trip the breaker. Returns a halt
// reason, or null when the cycle is within tolerance.
export function evaluateAnomaly(rec: { failed: number }): string | null {
  if (!config.ANOMALY_HALT_ENABLED) return null;
  if (rec.failed >= config.ANOMALY_MAX_FAILURES) {
    return `anomaly halt: ${rec.failed} failed executions in one cycle (threshold ${config.ANOMALY_MAX_FAILURES})`;
  }
  return null;
}

// Count (schedule, cycle, token_in, token_out) groups that violate the
// idempotency invariant. Should always be 0; the unique index makes a second
// write of the same action fail.
export async function duplicateExecutionCount(): Promise<number> {
  const groups = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(executions)
    .where(and(isNotNull(executions.scheduleId), isNotNull(executions.cycleId)))
    .groupBy(
      executions.scheduleId,
      executions.cycleId,
      executions.kind,
      sql`coalesce(${executions.tokenIn}, '')`,
      sql`coalesce(${executions.tokenOut}, '')`,
    )
    .having(sql`count(*) > 1`);
  return groups.length;
}
