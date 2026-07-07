// Shared, pure classification of a money-script result status, plus the rebalance
// buy-budget rule. Kept dependency-free (no DB/RPC) so both the engine accounting
// and fx_rebalance's leg tally classify identically and can be unit-tested:
// broadcast_unknown is NEVER a failure and never retried; skipped_* is surfaced
// separately; only a genuine never-broadcast failure counts as a failure.
export type MoveClass = "ok" | "unknown" | "skipped" | "reverted" | "failed";

export function classifyMove(status: string): MoveClass {
  if (status === "confirmed" || status === "success" || status === "dry_run") return "ok";
  if (status === "broadcast_unknown") return "unknown";
  if (status === "reverted") return "reverted";
  if (status.startsWith("skipped")) return "skipped";
  return "failed";
}

// cUSD (USD) available to fund fx_rebalance buys: the balance after the sells,
// minus cUSD's own target allocation, floored at zero. So buys never drain cUSD
// below its target and, when sells produced nothing, there is no buy budget.
export function buyBudgetUsd(cusdNow: number, cusdTargetValue: number): number {
  return Math.max(0, cusdNow - cusdTargetValue);
}
