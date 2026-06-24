// Liveness probe. DB-independent on purpose: it answers 200 as long as the web
// process is up, so a watchdog can distinguish "process down" from "dependency
// degraded". Use /api/readyz for a deeper DB/RPC check.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
