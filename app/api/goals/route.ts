// Savings goals: list (with USD progress) and create. Creating a goal creates
// its own savings_sweep schedule in the same call, so contributions start on
// the next heartbeat; the optional lock makes the engine refuse Aave
// withdrawals that would cut into the goal (skipped_locked) until the date.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { goals, schedules } from "../../../shared/db/schema.js";
import { validateParams } from "../../../shared/scheduleParams.js";
import { isValidCadence } from "../../../shared/cadence.js";
import { AAVE_APPROVED_ASSETS } from "../../../shared/addresses.js";
import { listGoalsWithProgress } from "../../../shared/goals.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateBody = z.object({
  name: z
    .string()
    .min(2)
    .max(60)
    .transform((s) => s.replace(/\s+/g, " ").trim()),
  targetUsd: z.coerce.number().positive().max(10000),
  asset: z.string().default("cUSD"),
  // Share of idle balance each sweep moves into Aave (savings_sweep semantics).
  pct: z.coerce.number().min(0.01).max(1).default(0.2),
  cadence: z.string().refine(isValidCadence, "unsupported cadence").default("daily"),
  lockDays: z.coerce.number().int().min(1).max(365).optional(),
});

export async function GET(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await listGoalsWithProgress(userId);
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  if (!AAVE_APPROVED_ASSETS.has(body.asset)) {
    return NextResponse.json({ error: `asset ${body.asset} is not supported for savings` }, { status: 400 });
  }

  let params: Record<string, unknown>;
  try {
    params = validateParams("savings_sweep", { pct: body.pct, asset: body.asset });
  } catch (err) {
    return NextResponse.json({ error: "invalid savings params", detail: (err as Error).message }, { status: 400 });
  }

  const [schedule] = await db
    .insert(schedules)
    .values({
      userId,
      kind: "savings_sweep",
      params,
      cadence: body.cadence,
      nextRun: new Date(),
      status: "active",
    })
    .returning();
  if (!schedule) return NextResponse.json({ error: "could not create schedule" }, { status: 500 });

  const lockUntil = body.lockDays
    ? new Date(Date.now() + body.lockDays * 24 * 60 * 60 * 1000)
    : null;
  const [goal] = await db
    .insert(goals)
    .values({
      userId,
      scheduleId: schedule.id,
      name: body.name,
      asset: body.asset,
      targetUsd: body.targetUsd.toString(),
      lockUntil,
      status: "active",
    })
    .returning();

  return NextResponse.json({
    goalId: goal?.id,
    scheduleId: schedule.id,
    lockUntil: lockUntil?.toISOString() ?? null,
  });
}
