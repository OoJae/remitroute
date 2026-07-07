// After a post-broadcast error (typically a waitForTransactionReceipt timeout or
// a transient RPC failure AFTER writeContract returned a hash), determine the
// real fate of the transaction. This is the fix for the double-spend bug: a send
// whose receipt lookup throws must NEVER be recorded "failed" and retried,
// because the original transaction may still be mined. We reconcile on chain and
// only return a retriable "failed" when no transaction was ever broadcast.
import { publicClient } from "./viem.js";
import { log } from "./log.js";

// Bound how long a money script waits for a receipt. Without this, viem polls
// indefinitely, so a broadcast-but-slow tx pins a schedule in "processing" long
// enough for the reclaim sweep to resurrect it. On timeout the wait throws into
// reconcileTx, which resolves the tx to confirmed/reverted/broadcast_unknown.
export const RECEIPT_TIMEOUT_MS = 120_000;

export type Fate = "confirmed" | "reverted" | "broadcast_unknown" | "failed";

export async function reconcileTx(txHash: string | undefined): Promise<Fate> {
  // No hash means writeContract never returned, so nothing was broadcast: safe to
  // mark failed and retry on the next cadence.
  if (!txHash) return "failed";

  // The hash exists, so a transaction WAS broadcast. Poll for its receipt before
  // giving up. If it is mined we know the outcome; if not, it is unknown and must
  // not be retried (retrying could double-send).
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      return receipt.status === "success" ? "confirmed" : "reverted";
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  log.warn(
    { txHash },
    "transaction fate unknown after broadcast; recording broadcast_unknown (will NOT retry to avoid a double-send)",
  );
  return "broadcast_unknown";
}
