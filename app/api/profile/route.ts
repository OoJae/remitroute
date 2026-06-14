// Update a user's profile (city, country, display name). City feeds the Phase 10
// live-feed-by-city dashboard. Collected once during onboarding in the Mini App.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  user: z.string().uuid(),
  city: z.string().max(80).optional(),
  country: z.string().max(80).optional(),
  displayName: z.string().max(80).optional(),
});

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { user, city, country, displayName } = parsed.data;

  const patch: Record<string, string> = {};
  if (city !== undefined) patch.city = city;
  if (country !== undefined) patch.country = country;
  if (displayName !== undefined) patch.displayName = displayName;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await db.update(users).set(patch).where(eq(users.id, user)).returning();
  if (updated.length === 0) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }
  const u = updated[0]!;
  return NextResponse.json({ city: u.city, country: u.country, displayName: u.displayName });
}
