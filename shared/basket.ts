// Pure decision math for the autonomous FX treasury basket agent. No I/O and no
// chain access, so the drift and signal logic is unit-testable on its own and the
// loop that broadcasts stays a thin shell around it.
//
// The agent holds a multi-currency Mento basket at target value weights. Each
// tick it values every leg in cUSD (the hub), works out how far each leg has
// drifted from its target, and trades the single most actionable leg back toward
// target through the hub. A short moving average per symbol tilts that choice:
// a leg trading below its own recent average is a better buy, one trading above
// it is a better sell. That tilt is what makes the behavior vary tick to tick
// rather than mechanically oscillating, and it gives every action a reason.

export interface BasketLeg {
  symbol: string;
  // Value of the wallet's balance of this leg, denominated in cUSD.
  valueUsd: number;
  // Normalized target weight, 0..1.
  target: number;
}

export interface PickOpts {
  hub?: string;
  // Only act once a leg is this far off target.
  driftThresholdBps?: number;
  // Ceiling on a single leg, in cUSD. Deep pools tolerate a large leg; thin
  // local-currency pools must stay small or they move the price against us.
  maxLegUsd?: number;
  // Per-symbol override of maxLegUsd, keyed by the non-hub symbol of the trade.
  maxLegUsdBySymbol?: Record<string, number>;
  // Anything smaller than this is not worth a transaction.
  minLegUsd?: number;
  // Per-symbol deviation of the current price from its moving average, in bps.
  // Negative means the leg is cheap relative to its recent average.
  signalBySymbol?: Record<string, number>;
  // How strongly the signal tilts the choice against raw drift.
  signalWeight?: number;
}

export interface RebalanceLeg {
  from: string;
  to: string;
  amountUsd: number;
  driftBps: number;
  currentWeight: number;
  target: number;
  deviationBps: number;
  rationale: string;
}

const DEFAULT_HUB = "cUSD";
const DEFAULT_DRIFT_BPS = 200;
const DEFAULT_MIN_LEG_USD = 0.05;
const DEFAULT_SIGNAL_WEIGHT = 0.5;

// Signed distance of a leg's current weight from its target, in basis points.
// Positive means the leg is over target and is a sell candidate.
export function computeDriftBps(currentWeight: number, target: number): number {
  return (currentWeight - target) * 10000;
}

// Append a price to a rolling window and report the window mean plus how far the
// latest price sits from it. Returns a new array rather than mutating, so callers
// can hold the ring in a plain map. deviationBps is 0 until the window has enough
// history to mean anything.
export function updateMovingAverage(
  ring: number[],
  price: number,
  window: number,
): { ring: number[]; ma: number; deviationBps: number } {
  const size = Math.max(2, Math.floor(window));
  const next = [...ring, price].slice(-size);
  const ma = next.reduce((a, b) => a + b, 0) / next.length;
  const deviationBps = next.length < 2 || ma <= 0 ? 0 : ((price - ma) / ma) * 10000;
  return { ring: next, ma, deviationBps };
}

// Choose the single most actionable leg to trade this tick, or null when the
// basket is already within tolerance (or there is nothing worth trading).
//
// Sells route leg -> hub, buys route hub -> leg, mirroring rebalance.ts: the hub
// is never traded against itself and is rebalanced implicitly by the other legs.
// `hubAvailableUsd` is how much hub the caller is willing to spend on buys (it
// already excludes the hub's own target share and any gas reserve), so a buy can
// never drain the hub below where it should sit.
export function pickRebalanceLeg(
  legs: BasketLeg[],
  hubAvailableUsd: number,
  opts: PickOpts = {},
): RebalanceLeg | null {
  const hub = opts.hub ?? DEFAULT_HUB;
  const threshold = opts.driftThresholdBps ?? DEFAULT_DRIFT_BPS;
  const minLeg = opts.minLegUsd ?? DEFAULT_MIN_LEG_USD;
  const maxLegFor = (symbol: string): number =>
    opts.maxLegUsdBySymbol?.[symbol] ?? opts.maxLegUsd ?? Number.POSITIVE_INFINITY;
  const signals = opts.signalBySymbol ?? {};
  const signalWeight = opts.signalWeight ?? DEFAULT_SIGNAL_WEIGHT;

  const total = legs.reduce((a, l) => a + l.valueUsd, 0);
  if (total <= 0) return null;

  let best: RebalanceLeg | null = null;
  let bestScore = 0;

  for (const leg of legs) {
    if (leg.symbol === hub) continue;
    const currentWeight = leg.valueUsd / total;
    const driftBps = computeDriftBps(currentWeight, leg.target);
    const deviationBps = signals[leg.symbol] ?? 0;

    let candidate: RebalanceLeg | null = null;
    let score = 0;

    if (driftBps > threshold && leg.valueUsd > 0) {
      // Over target: trim the excess back into the hub. Selling is more
      // attractive when the leg is also trading above its own average.
      const excessUsd = (currentWeight - leg.target) * total;
      const amountUsd = Math.min(excessUsd, maxLegFor(leg.symbol), leg.valueUsd);
      if (amountUsd >= minLeg) {
        score = Math.abs(driftBps) + signalWeight * deviationBps;
        candidate = {
          from: leg.symbol,
          to: hub,
          amountUsd,
          driftBps,
          currentWeight,
          target: leg.target,
          deviationBps,
          rationale: reasonFor("sell", leg.symbol, hub, currentWeight, leg.target, driftBps, deviationBps),
        };
      }
    } else if (driftBps < -threshold) {
      // Under target: top the leg back up out of the hub. Buying is more
      // attractive when the leg is also trading below its own average.
      const deficitUsd = (leg.target - currentWeight) * total;
      const amountUsd = Math.min(deficitUsd, maxLegFor(leg.symbol), Math.max(0, hubAvailableUsd));
      if (amountUsd >= minLeg) {
        score = Math.abs(driftBps) + signalWeight * -deviationBps;
        candidate = {
          from: hub,
          to: leg.symbol,
          amountUsd,
          driftBps,
          currentWeight,
          target: leg.target,
          deviationBps,
          rationale: reasonFor("buy", leg.symbol, hub, currentWeight, leg.target, driftBps, deviationBps),
        };
      }
    }

    if (candidate && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

// One human sentence explaining the trade, stored next to the transaction so the
// ledger reads as a record of decisions rather than a list of swaps.
function reasonFor(
  side: "buy" | "sell",
  symbol: string,
  hub: string,
  currentWeight: number,
  target: number,
  driftBps: number,
  deviationBps: number,
): string {
  const now = (currentWeight * 100).toFixed(1);
  const want = (target * 100).toFixed(1);
  const off = (Math.abs(driftBps) / 100).toFixed(1);
  const base =
    side === "sell"
      ? `${symbol} is ${now}% of the basket against a ${want}% target (${off}% over), trimming into ${hub}`
      : `${symbol} is ${now}% of the basket against a ${want}% target (${off}% under), topping up from ${hub}`;
  if (Math.abs(deviationBps) < 25) return base;
  const dev = (Math.abs(deviationBps) / 100).toFixed(2);
  const cheapOrRich = deviationBps < 0 ? `${dev}% below` : `${dev}% above`;
  return `${base}; it is trading ${cheapOrRich} its recent average`;
}
