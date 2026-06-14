// Exposes the registered agent id and the Reputation Registry address so the
// Mini App can let a user submit feedback from their own MiniPay wallet. MiniPay
// is on Celo mainnet, so the mainnet reputation registry is used for feedback.
import { NextResponse } from "next/server";
import { config } from "../../../shared/config.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPUTATION_MAINNET = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

export async function GET() {
  return NextResponse.json({
    agentId: config.AGENT_ID ?? null,
    reputationRegistry: REPUTATION_MAINNET,
    chainId: 42220,
  });
}
