// Serves the ERC-8004 registration JSON at /.well-known/agent.json (via a
// next.config rewrite). This is the a2a endpoint referenced in the registration.
import { NextResponse } from "next/server";
import { buildRegistration } from "../../../shared/registration.js";
import { config } from "../../../shared/config.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ZERO = "0x0000000000000000000000000000000000000000";

export async function GET() {
  const owner = config.AGENT_WALLET_ADDRESS ?? ZERO;
  const doc = buildRegistration(owner);
  return NextResponse.json(doc, {
    headers: { "content-type": "application/json" },
  });
}
