// Onboard a MiniPay user. Upsert by MiniPay address and assign a dedicated
// execution wallet with an encrypted key. Returns the user id and the execution
// wallet address. The private key never leaves the server.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAddress, getAddress } from "viem";
import { db } from "../../../shared/db/client.js";
import { users } from "../../../shared/db/schema.js";
import { createExecutionWallet } from "../../../shared/wallet.js";
import { log } from "../../../shared/log.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  minipayAddress: z.string().refine((a) => isAddress(a), "invalid address"),
  displayName: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const minipayAddress = getAddress(parsed.data.minipayAddress);

  // Return the existing user if already onboarded.
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.minipayAddress, minipayAddress));
  if (existing) {
    return NextResponse.json({
      userId: existing.id,
      executionWallet: existing.walletAddress,
      city: existing.city,
      displayName: existing.displayName,
    });
  }

  const wallet = createExecutionWallet();
  const [created] = await db
    .insert(users)
    .values({
      minipayAddress,
      displayName: parsed.data.displayName ?? null,
      city: parsed.data.city ?? null,
      country: parsed.data.country ?? null,
      walletAddress: wallet.address,
      walletKeyRef: wallet.keyRef,
    })
    .returning();

  if (!created) {
    return NextResponse.json({ error: "could not create user" }, { status: 500 });
  }

  log.info(
    { userId: created.id, executionWallet: wallet.address },
    "onboarded new user with execution wallet",
  );
  return NextResponse.json({
    userId: created.id,
    executionWallet: wallet.address,
    city: created.city,
    displayName: created.displayName,
  });
}
