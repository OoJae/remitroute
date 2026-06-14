// Returns the cUSD transfer parameters the MiniPay client signs to fund a user's
// execution wallet. The client builds the calldata; this endpoint resolves the
// execution wallet target and the token so the client never guesses an address.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";
import { TOKENS, FEE_ADAPTERS } from "../../../shared/addresses.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const QuerySchema = z.object({
  user: z.string().uuid(),
  amount: z.string().refine((a) => Number(a) > 0, "amount must be positive"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    user: url.searchParams.get("user"),
    amount: url.searchParams.get("amount") ?? "1",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid query" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, parsed.data.user));
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }

  return NextResponse.json({
    token: TOKENS.cUSD.address,
    decimals: TOKENS.cUSD.decimals,
    to: user.walletAddress,
    amount: parsed.data.amount,
    // Gas paid in cUSD. The client sets this as feeCurrency on the legacy tx.
    feeCurrency: FEE_ADAPTERS.cUSD,
  });
}
