// User-initiated withdraw of execution-wallet funds back to the user's own
// MiniPay address. The destination is resolved server-side from the users row;
// a caller can never supply it. Real onchain when WITHDRAW_LIVE is true.
import { NextResponse } from "next/server";
import { z } from "zod";
import { withdraw } from "../../../openclaw/skills/transfer/scripts/withdraw-to-user.js";
import { log } from "../../../shared/log.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  user: z.string().uuid(),
  token: z.enum(["cUSD", "USDC", "cEUR"]),
  amount: z.string().refine((a) => a === "max" || Number(a) > 0, "amount must be positive or 'max'"),
});

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await withdraw(parsed.data);
    const status = result.status === "failed" ? 502 : 200;
    return NextResponse.json(result, { status });
  } catch (err) {
    log.error({ err }, "withdraw route failed");
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
