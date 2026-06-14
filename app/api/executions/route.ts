// Read a user's executions ledger for the in-app activity view.
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../shared/db/client.js";
import { executions } from "../../../shared/db/schema.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const QuerySchema = z.string().uuid();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse(url.searchParams.get("user"));
  if (!parsed.success) {
    return NextResponse.json({ error: "user query param must be a uuid" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(executions)
    .where(eq(executions.userId, parsed.data))
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
