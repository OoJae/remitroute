// Create a schedule row directly, for seeding and testing the loop. The Mini App
// uses the /api/schedules route for the same purpose. Natural-language parsing
// (parse-rule.ts) is a later phase; this takes structured input only.
//
// Example:
//   tsx create-schedule.ts --user <uuid> --kind remittance \
//     --params '{"to":"0x..","amount":"0.02","token":"cUSD"}' \
//     --cadence daily --next-run -1m
import { z } from "zod";
import { db, pool } from "../../../../shared/db/client.js";
import { schedules } from "../../../../shared/db/schema.js";
import { CadenceSchema } from "../../../../shared/cadence.js";
import { ScheduleKind, validateParams } from "../../../../shared/scheduleParams.js";
import { log } from "../../../../shared/log.js";

export const ScheduleInput = z.object({
  user: z.string().uuid(),
  kind: ScheduleKind,
  params: z.record(z.unknown()),
  cadence: CadenceSchema,
  // ISO string, "now", or a relative offset like "-1m", "+30m", "-2h".
  nextRun: z.string().default("now"),
});

export type ScheduleInputType = z.infer<typeof ScheduleInput>;

// Resolve a next-run spec into a Date.
export function resolveNextRun(spec: string): Date {
  const s = spec.trim();
  if (s === "now") return new Date();
  const rel = /^([+-]\d+)(m|h)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const ms = (rel[2] === "h" ? 60 : 1) * 60 * 1000 * n;
    return new Date(Date.now() + ms);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`bad next-run spec: ${spec}`);
  return d;
}

export async function createSchedule(input: ScheduleInputType): Promise<string> {
  const parsed = ScheduleInput.parse(input);
  // Validate and normalize the params against the kind's schema so a malformed
  // rule can never be saved.
  const params = validateParams(parsed.kind, parsed.params);
  const nextRun = resolveNextRun(parsed.nextRun);
  const [row] = await db
    .insert(schedules)
    .values({
      userId: parsed.user,
      kind: parsed.kind,
      params,
      cadence: parsed.cadence,
      nextRun,
      status: "active",
    })
    .returning();
  if (!row) throw new Error("failed to insert schedule");
  log.info(
    { scheduleId: row.id, kind: parsed.kind, cadence: parsed.cadence, nextRun: nextRun.toISOString() },
    "schedule created",
  );
  return row.id;
}

function parseCliArgs(argv: string[]): Record<string, string> {
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

const invokedDirectly = process.argv[1]?.endsWith("create-schedule.ts");
if (invokedDirectly) {
  const a = parseCliArgs(process.argv.slice(2));
  createSchedule({
    user: a.user ?? "",
    kind: (a.kind ?? "remittance") as ScheduleInputType["kind"],
    params: JSON.parse(a.params ?? "{}"),
    cadence: a.cadence ?? "daily",
    nextRun: a["next-run"] ?? "now",
  })
    .then(async (id) => {
      log.info({ scheduleId: id }, "created");
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err }, "create-schedule failed");
      await pool.end();
      process.exit(1);
    });
}
