// Record ERC-8004 feedback that a MiniPay user signed and submitted from their
// own wallet. The onchain giveFeedback is done client-side; this logs it.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAddress, getAddress } from "viem";
import { db } from "../../../shared/db/client.js";
import { users, feedbackLog } from "../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  user: z.string().uuid(),
  clientAddress: z.string().refine((a) => isAddress(a), "invalid address"),
  score: z.coerce.number().int().min(0).max(100),
  tag: z.string().min(1).max(64),
  txHash: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, parsed.data.user));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  await db.insert(feedbackLog).values({
    userId: parsed.data.user,
    clientAddress: getAddress(parsed.data.clientAddress),
    score: parsed.data.score,
    tag: parsed.data.tag,
    txHash: parsed.data.txHash ?? null,
  });

  return NextResponse.json({ ok: true });
}
