// Read a user's executions ledger for the in-app activity view.
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../shared/db/client.js";
import { executions } from "../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(executions)
    .where(eq(executions.userId, userId))
    .orderBy(desc(executions.createdAt))
    .limit(50);

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    amountIn: r.amountIn,
    tokenIn: r.tokenIn,
    txHash: r.txHash,
    createdAt: r.createdAt,
  }));

  return NextResponse.json({ items });
}
