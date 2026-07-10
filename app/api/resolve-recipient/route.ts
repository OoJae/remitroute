// Resolve a phone number to the recipient's MiniPay wallet via Celo
// SocialConnect, so a rule can be created from the number in the user's
// contacts instead of a raw 0x address. Session-authenticated and rate-limited
// (each lookup consumes paid ODIS quota).
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhone } from "../../../shared/phoneLookup.js";
import { rateLimit } from "../../../shared/ratelimit.js";
import { log } from "../../../shared/log.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  phone: z
    .string()
    .transform((s) => s.replace(/[\s()-]/g, ""))
    .refine((s) => /^\+[1-9]\d{7,14}$/.test(s), "phone must be in international format, e.g. +2348012345678"),
});

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit(`resolve-recipient:${userId}`, { max: 10, windowSec: 3600 });
  if (!rl.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid phone" },
      { status: 400 },
    );
  }

  try {
    const address = await resolvePhone(parsed.data.phone);
    if (!address) {
      return NextResponse.json(
        {
          error:
            "That number is not on MiniPay yet. Ask them to install MiniPay, or paste their wallet address instead.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ phone: parsed.data.phone, address });
  } catch (err) {
    log.warn({ err }, "phone resolution failed");
    return NextResponse.json(
      { error: "Could not look that number up right now. Try again shortly." },
      { status: 503 },
    );
  }
}
