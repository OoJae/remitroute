// Manage a single rule: pause/resume (PATCH) or delete (DELETE, soft-cancel).
// Authorized by matching the row's userId to the caller-provided user, the same
// trust model as the rest of the Mini App (no separate auth system).
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../shared/db/client.js";
import { schedules } from "../../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PatchBody = z.object({
  action: z.enum(["pause", "resume"]),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid schedule id" }, { status: 400 });
  }
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const nextStatus = parsed.data.action === "pause" ? "paused" : "active";
  const updated = await db
    .update(schedules)
    .set({ status: nextStatus })
    .where(and(eq(schedules.id, id), eq(schedules.userId, userId)))
    .returning();

  if (updated.length === 0) {
    return NextResponse.json({ error: "rule not found" }, { status: 404 });
  }
  return NextResponse.json({ id, status: nextStatus });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid schedule id" }, { status: 400 });
  }

  const updated = await db
    .update(schedules)
    .set({ status: "cancelled" })
    .where(and(eq(schedules.id, id), eq(schedules.userId, userId)))
    .returning();

  if (updated.length === 0) {
    return NextResponse.json({ error: "rule not found" }, { status: 404 });
  }
  return NextResponse.json({ id, status: "cancelled" });
}
