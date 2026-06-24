// Update the authenticated user's profile (city, country, display name). City
// feeds the public live-feed-by-city dashboard, so values are trimmed, length
// capped, and rendered as plain text (React escapes them) on the dashboard.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Trim and collapse internal whitespace; the length cap bounds storage and the
// dashboard renders the result as text, so no markup can execute.
const cleanField = z
  .string()
  .max(80)
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .optional();

const BodySchema = z.object({
  city: cleanField,
  country: cleanField,
  displayName: cleanField,
});

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { city, country, displayName } = parsed.data;

  const patch: Record<string, string> = {};
  if (city) patch.city = city;
  if (country) patch.country = country;
  if (displayName) patch.displayName = displayName;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await db.update(users).set(patch).where(eq(users.id, userId)).returning();
  if (updated.length === 0) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }
  const u = updated[0]!;
  return NextResponse.json({ city: u.city, country: u.country, displayName: u.displayName });
}
