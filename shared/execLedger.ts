// Pre-broadcast intent reservation for the money scripts. reserveIntent inserts
// a `pending` execution row keyed on the unique (user_id, intent_id) index BEFORE
// any transaction is broadcast; if the row already exists (a crash-then-reclaim
// re-run of the same schedule slot), it returns null and the caller must NOT
// broadcast again. finalizeExecution updates that reserved row to its terminal
// state on completion, so exactly one ledger row exists per intent.
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { executions } from "./db/schema.js";
import { config } from "./config.js";
import { emitReceipt } from "./receipts.js";

export interface ReserveParams {
  userId: string;
  scheduleId?: string;
  cycleId?: string;
  intentId: string;
  kind: string;
  amountIn?: string | null;
  // USD-equivalent value of this move (usdValueOf); the reserved pending row
  // carries it so caps count USD from the moment the intent is reserved.
  usdValue?: number | null;
  tokenIn?: string;
  tokenOut?: string;
}

// Returns the new pending row id, or null if this intent was already reserved.
export async function reserveIntent(p: ReserveParams): Promise<string | null> {
  const inserted = await db
    .insert(executions)
    .values({
      userId: p.userId,
      scheduleId: p.scheduleId ?? null,
      cycleId: p.cycleId ?? null,
      intentId: p.intentId,
      kind: p.kind,
      status: "pending",
      amountIn: p.amountIn ?? null,
      usdValue: p.usdValue != null ? p.usdValue.toString() : null,
      tokenIn: p.tokenIn ?? null,
      tokenOut: p.tokenOut ?? null,
      feeCurrency: config.FEE_CURRENCY,
    })
    .onConflictDoNothing({ target: [executions.userId, executions.intentId] })
    .returning({ id: executions.id });
  return inserted[0]?.id ?? null;
}

export interface FinalizeParams {
  status: string;
  txHash?: string;
  amountOut?: string;
  error?: string;
}

export async function finalizeExecution(id: string, u: FinalizeParams): Promise<void> {
  const set: Record<string, unknown> = { status: u.status, error: u.error ?? null };
  if (u.txHash !== undefined) set.txHash = u.txHash;
  if (u.amountOut !== undefined) set.amountOut = u.amountOut;
  const [row] = await db.update(executions).set(set).where(eq(executions.id, id)).returning();
  // The user's receipt for this action (never throws, no-op when unlinked).
  await emitReceipt(row);
}
