// Parse a plain-language rule into a structured schedule for the user to confirm.
// Does NOT save; the client confirms then POSTs to /api/schedules.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";
import { parseRule } from "../../../openclaw/skills/remitroute-core/scripts/parse-rule.js";
import { rateLimit } from "../../../shared/ratelimit.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  text: z.string().min(3).max(500),
});

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit(`parse-rule:${userId}`, { max: 10, windowSec: 60 });
  if (!rl.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  try {
    const rule = await parseRule(userId, parsed.data.text);
    return NextResponse.json(rule);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }
}
