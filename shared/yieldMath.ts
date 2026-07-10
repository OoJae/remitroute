// Pure yield arithmetic for the Mini App's savings display. Dependency-free
// (no viem, no DB) so both the balance API and unit tests share the exact same
// numbers the user sees.

// Aave V3 reports currentLiquidityRate as an APR in ray units (1e27), accrued
// per second. Convert to the effective APY percentage the user actually earns.
const RAY = 1e27;
const SECONDS_PER_YEAR = 31_536_000;

export function apyFromRay(rateRay: bigint): number {
  const apr = Number(rateRay) / RAY;
  if (!Number.isFinite(apr) || apr <= 0) return 0;
  return ((1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1) * 100;
}

// Net amount the user has contributed into the yield position, replayed from
// the execution ledger (oldest first). Supplies add; withdrawals subtract; a
// "max" withdrawal has no recorded amount and empties the position, so it
// resets the baseline to zero. Interest earned = current aToken balance minus
// this net figure (clamped at zero and labeled approximate in the UI, because
// a max withdrawal also swept out any interest accrued to that point).
export interface LedgerRow {
  kind: string;
  status: string;
  amountIn: string | null;
}

const COUNTED = new Set(["confirmed", "success"]);

export function netContributed(rowsOldestFirst: LedgerRow[]): number {
  let net = 0;
  for (const row of rowsOldestFirst) {
    if (!COUNTED.has(row.status)) continue;
    if (row.kind === "yield_withdraw") {
      if (row.amountIn === null || row.amountIn === undefined) {
        net = 0; // "max" withdrawal: position emptied, baseline resets
      } else {
        net = Math.max(0, net - Number(row.amountIn));
      }
    } else if (row.amountIn != null) {
      // Any supplying kind (savings_sweep and future variants) adds.
      net += Number(row.amountIn);
    }
  }
  return net;
}

export function earnedApprox(suppliedNow: number, net: number): number {
  return Math.max(0, suppliedNow - net);
}
