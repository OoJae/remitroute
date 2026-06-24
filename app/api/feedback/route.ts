// Record ERC-8004 feedback that the authenticated MiniPay user signed and
// submitted from their own wallet. The onchain giveFeedback is done client-side;
// this logs it ONLY after confirming the referenced tx exists, is confirmed, and
// was sent from the session's bound address, and dedupes by txHash. This stops
// forging arbitrary scores under any userId/clientAddress.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { feedbackLog } from "../../../shared/db/schema.js";
import { publicClient } from "../../../shared/viem.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  score: z.coerce.number().int().min(0).max(100),
  tag: z.string().min(1).max(64),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a confirmed feedback txHash is required"),
});

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  const addr = request.headers.get("x-user-address");
  if (!userId || !addr) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const txHash = parsed.data.txHash as `0x${string}`;

  // The feedback must be backed by a real, confirmed onchain tx from the user.
  let from: string;
  let ok: boolean;
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    from = receipt.from.toLowerCase();
    ok = receipt.status === "success";
  } catch {
    return NextResponse.json({ error: "feedback tx not found onchain yet" }, { status: 422 });
  }
  if (!ok || from !== addr.toLowerCase()) {
    return NextResponse.json(
      { error: "feedback tx is not confirmed or was not sent from your wallet" },
      { status: 422 },
    );
  }

  // Idempotent on txHash: a feedback tx is logged once.
  const existing = await db
    .select({ id: feedbackLog.id })
    .from(feedbackLog)
    .where(eq(feedbackLog.txHash, txHash))
    .limit(1);
  if (existing.length > 0) return NextResponse.json({ ok: true, deduped: true });

  await db.insert(feedbackLog).values({
    userId,
    clientAddress: getAddress(addr),
    score: parsed.data.score,
    tag: parsed.data.tag,
    txHash,
  });
  return NextResponse.json({ ok: true });
}
