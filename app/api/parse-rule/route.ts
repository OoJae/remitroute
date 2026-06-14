// Parse a plain-language rule into a structured schedule for the user to confirm.
// Does NOT save; the client confirms then POSTs to /api/schedules.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";
import { parseRule } from "../../../openclaw/skills/remitroute-core/scripts/parse-rule.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  user: z.string().uuid(),
  text: z.string().min(3).max(500),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, parsed.data.user));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  try {
    const rule = await parseRule(parsed.data.user, parsed.data.text);
    return NextResponse.json(rule);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }
}
