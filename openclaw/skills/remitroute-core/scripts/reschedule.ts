// Recompute and persist a schedule's next_run from its cadence. Used by
// run-due.ts after each execution and after manual edits. A `once` cadence (or
// any cadence returning null) marks the schedule done so it stops recurring.
// Run: tsx openclaw/skills/remitroute-core/scripts/reschedule.ts --schedule <id>
import { eq } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { schedules } from "../../../../shared/db/schema.js";
import { computeNextRun } from "../../../../shared/cadence.js";
import { log } from "../../../../shared/log.js";

export interface RescheduleResult {
  status: "active" | "done";
  nextRun: Date | null;
}

// Recompute next_run for a schedule, starting from `from` (default now).
export async function reschedule(
  scheduleId: string,
  from: Date = new Date(),
): Promise<RescheduleResult> {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
  if (!row) throw new Error(`unknown schedule ${scheduleId}`);

  const next = computeNextRun(row.cadence, from);

  if (next === null) {
    await db.update(schedules).set({ status: "done" }).where(eq(schedules.id, scheduleId));
    log.info({ scheduleId, cadence: row.cadence }, "schedule marked done (no next run)");
    return { status: "done", nextRun: null };
  }

  await db
    .update(schedules)
    .set({ nextRun: next, status: "active" })
    .where(eq(schedules.id, scheduleId));
  log.info({ scheduleId, cadence: row.cadence, nextRun: next.toISOString() }, "rescheduled");
  return { status: "active", nextRun: next };
}

function parseCliArgs(argv: string[]): { schedule?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined) {
        out[key] = val;
        i += 1;
      }
    }
  }
  return out;
}

const invokedDirectly = process.argv[1]?.endsWith("reschedule.ts");
if (invokedDirectly) {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.schedule) {
    log.error("usage: reschedule.ts --schedule <id>");
    process.exit(1);
  }
  reschedule(args.schedule)
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err }, "reschedule failed");
      await pool.end();
      process.exit(1);
    });
}
