// Manage one savings goal: cancel it (pauses its sweep schedule) or unlock it
// early. Early unlock is deliberate friction, not a wall: it requires an
// explicit confirm and takes effect immediately.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../shared/db/client.js";
import { goals, schedules } from "../../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  action: z.enum(["cancel", "unlock"]),
  confirm: z.boolean().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, userId)));
  if (!goal) return NextResponse.json({ error: "goal not found" }, { status: 404 });

  if (parsed.data.action === "unlock") {
    if (!parsed.data.confirm) {
      return NextResponse.json({ error: "unlocking early requires confirm: true" }, { status: 400 });
    }
    await db.update(goals).set({ lockUntil: null }).where(eq(goals.id, goal.id));
    return NextResponse.json({ id: goal.id, status: goal.status, lockUntil: null });
  }

  // cancel: stop the sweep and retire the goal (history stays in the ledger).
  await db.update(goals).set({ status: "cancelled" }).where(eq(goals.id, goal.id));
  if (goal.scheduleId) {
    await db
      .update(schedules)
      .set({ status: "paused" })
      .where(and(eq(schedules.id, goal.scheduleId), eq(schedules.status, "active")));
  }
  return NextResponse.json({ id: goal.id, status: "cancelled" });
}
