// Readiness probe. Checks the dependencies the engine needs: the database and
// the Celo RPC. Returns 503 when a dependency is down so a load balancer / uptime
// monitor can react, while /api/healthz stays up for plain liveness.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../shared/db/client.js";
import { publicClient } from "../../../shared/viem.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const checks: Record<string, boolean> = { db: false, rpc: false };
  try {
    await db.execute(sql`select 1`);
    checks.db = true;
  } catch {
    /* db down */
  }
  try {
    await publicClient.getBlockNumber({ cacheTime: 0 });
    checks.rpc = true;
  } catch {
    /* rpc down */
  }
  const ok = checks.db && checks.rpc;
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
