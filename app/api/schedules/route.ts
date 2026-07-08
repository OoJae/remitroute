// Create and list schedules for a user. The Mini App uses this to set rules
// (structured form input). Natural-language parsing is a later phase.
import { NextResponse } from "next/server";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { schedules, users, recipients } from "../../../shared/db/schema.js";
import { CadenceSchema } from "../../../shared/cadence.js";
import { ScheduleKind, validateParams } from "../../../shared/scheduleParams.js";
import { resolveNextRun } from "../../../openclaw/skills/remitroute-core/scripts/create-schedule.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateBody = z.object({
  kind: ScheduleKind,
  params: z.record(z.unknown()),
  cadence: CadenceSchema,
  nextRun: z.string().default("now"),
});

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  // Validate params against the kind's schema before saving.
  let params: Record<string, unknown>;
  try {
    params = validateParams(parsed.data.kind, parsed.data.params);
  } catch (err) {
    return NextResponse.json(
      { error: "invalid params for kind", detail: (err as Error).message },
      { status: 400 },
    );
  }

  const nextRun = resolveNextRun(parsed.data.nextRun);
  const [row] = await db
    .insert(schedules)
    .values({
      userId,
      kind: parsed.data.kind,
      params,
      cadence: parsed.data.cadence,
      nextRun,
      status: "active",
    })
    .returning();

  // Allowlist the confirmed recipient for user-to-user transfers. send.ts refuses
  // to pay any address not on this per-user list, so a corrupted or tampered
  // schedule row cannot redirect funds; this authenticated create is the confirm
  // step that authorizes the destination.
  if (parsed.data.kind === "remittance" || parsed.data.kind === "bill_drip") {
    const to = typeof params.to === "string" ? params.to : undefined;
    if (to) await allowlistRecipient(userId, to);
  }

  return NextResponse.json({ scheduleId: row?.id, nextRun: nextRun.toISOString() });
}

// Add an address to the user's recipient allowlist, idempotently. The unique
// index on (user_id, lower(address)) makes a repeat a no-op; a concurrent create
// that wins the race just means the address is already allowlisted (benign).
async function allowlistRecipient(userId: string, address: string): Promise<void> {
  const existing = await db
    .select({ id: recipients.id })
    .from(recipients)
    .where(and(eq(recipients.userId, userId), sql`lower(${recipients.address}) = lower(${address})`))
    .limit(1);
  if (existing.length > 0) return;
  try {
    await db.insert(recipients).values({ userId, address });
  } catch {
    // Unique-index race: another request allowlisted the same address first.
  }
}

export async function GET(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.userId, userId), ne(schedules.status, "cancelled")))
    .orderBy(desc(schedules.createdAt))
    .limit(50);
  return NextResponse.json({ items: rows });
}
