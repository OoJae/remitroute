// fx_rebalance: keep a user's stablecoin basket at target value weights. Values
// each leg in cUSD via Mento quotes, sells legs that have drifted above their
// target into cUSD, then buys under-target legs from cUSD. Every leg is a typed
// swap() call (slippage, caps, feeCurrency, DRY_RUN all enforced there). This is
// the Guardian 3 drift logic; the scheduled fx_rebalance dispatch calls it.
import { erc20Abi, formatUnits, getAddress } from "viem";
import { eq } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { publicClient } from "../../../../shared/viem.js";
import { getMento, resolveMentoToken } from "../../../../shared/mento.js";
import { swap } from "../../mento-fx/scripts/swap.js";
import { log } from "../../../../shared/log.js";

const DEFAULT_DRIFT_BPS = 500; // rebalance a leg once it drifts 5 percent off target
const DUST_USD = 0.01; // ignore baskets or legs worth less than this in cUSD

export interface RebalanceOpts {
  driftThresholdBps?: number;
  slippageBps?: number;
  scheduleId?: string;
  cycleId?: string;
}

export interface RebalanceResult {
  swapsOk: number;
  swapsFailed: number;
  volume: number;
}

interface Leg {
  symbol: string;
  decimals: number;
  balanceUnits: bigint;
  balanceNum: number;
  valueUsd: number;
  target: number;
}

export async function rebalance(
  userId: string,
  rawTargets: Record<string, number>,
  opts: RebalanceOpts = {},
): Promise<RebalanceResult> {
  const result: RebalanceResult = { swapsOk: 0, swapsFailed: 0, volume: 0 };
  const threshold = opts.driftThresholdBps ?? DEFAULT_DRIFT_BPS;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error(`unknown user ${userId}`);
  const owner = getAddress(user.walletAddress);

  const mento = await getMento();
  const cusd = await resolveMentoToken("cUSD", mento);

  // Normalize target weights so they sum to 1.
  const targetSum = Object.values(rawTargets).reduce((a, b) => a + b, 0);
  if (targetSum <= 0) throw new Error("fx_rebalance targets sum to zero");
  const targets: Record<string, number> = {};
  for (const [sym, w] of Object.entries(rawTargets)) targets[sym] = w / targetSum;

  // Value each leg in cUSD.
  const legs: Leg[] = [];
  for (const [symbol, target] of Object.entries(targets)) {
    const token = await resolveMentoToken(symbol, mento);
    const balanceUnits = (await publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    const balanceNum = Number(formatUnits(balanceUnits, token.decimals));

    let valueUsd: number;
    if (token.address.toLowerCase() === cusd.address.toLowerCase()) {
      valueUsd = balanceNum;
    } else if (balanceUnits > 0n) {
      const quote = await mento.quotes.getAmountOut(token.address, cusd.address, balanceUnits);
      valueUsd = Number(formatUnits(quote, cusd.decimals));
    } else {
      valueUsd = 0;
    }
    legs.push({ symbol, decimals: token.decimals, balanceUnits, balanceNum, valueUsd, target });
  }

  const total = legs.reduce((a, l) => a + l.valueUsd, 0);
  log.info(
    { userId, total, legs: legs.map((l) => ({ s: l.symbol, v: l.valueUsd, t: l.target })) },
    "fx_rebalance basket valued",
  );
  if (total < DUST_USD) {
    log.info({ userId, total }, "fx_rebalance: basket below dust, nothing to do");
    return result;
  }

  // Sell legs that are over target by more than the threshold (skip cUSD; it is
  // the hub and is rebalanced implicitly by the buys and sells).
  for (const leg of legs) {
    if (leg.symbol === "cUSD" || leg.valueUsd <= 0) continue;
    const currentWeight = leg.valueUsd / total;
    const driftBps = (currentWeight - leg.target) * 10000;
    if (driftBps <= threshold) continue;
    const excessUsd = (currentWeight - leg.target) * total;
    // Sell the share of this leg's balance that represents the excess value.
    const sellTokens = leg.balanceNum * (excessUsd / leg.valueUsd);
    if (sellTokens <= 0) continue;
    const res = await swap({
      user: userId,
      tokenIn: leg.symbol,
      tokenOut: "cUSD",
      amountIn: sellTokens.toFixed(6),
      slippageBps: opts.slippageBps,
      kind: "fx_rebalance",
      scheduleId: opts.scheduleId,
      cycleId: opts.cycleId,
    });
    tally(result, res.status, sellTokens);
  }

  // Buy legs that are under target by more than the threshold, paying in cUSD.
  for (const leg of legs) {
    if (leg.symbol === "cUSD") continue;
    const currentWeight = leg.valueUsd / total;
    const driftBps = (leg.target - currentWeight) * 10000;
    if (driftBps <= threshold) continue;
    const deficitUsd = (leg.target - currentWeight) * total;
    if (deficitUsd < DUST_USD) continue;
    const res = await swap({
      user: userId,
      tokenIn: "cUSD",
      tokenOut: leg.symbol,
      amountIn: deficitUsd.toFixed(6),
      slippageBps: opts.slippageBps,
      kind: "fx_rebalance",
      scheduleId: opts.scheduleId,
      cycleId: opts.cycleId,
    });
    tally(result, res.status, deficitUsd);
  }

  log.info({ userId, ...result }, "fx_rebalance complete");
  return result;
}

function tally(result: RebalanceResult, status: string, amount: number): void {
  if (status === "confirmed" || status === "dry_run") {
    result.swapsOk += 1;
    result.volume += amount;
  } else if (status === "skipped_cap") {
    // not counted as ok or failed
  } else {
    result.swapsFailed += 1;
  }
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined) {
        out[key] = val;
        i += 1;
      }
    }
  }
  return out;
}

const invokedDirectly = process.argv[1]?.endsWith("rebalance.ts");
if (invokedDirectly) {
  const a = parseCliArgs(process.argv.slice(2));
  const targets = JSON.parse(a.targets ?? "{}") as Record<string, number>;
  rebalance(a.user ?? "", targets, {
    driftThresholdBps: a.driftThresholdBps ? Number(a.driftThresholdBps) : undefined,
    slippageBps: a.slippageBps ? Number(a.slippageBps) : undefined,
  })
    .then(async (r) => {
      log.info({ ...r }, "rebalance done");
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err }, "rebalance failed");
      await pool.end();
      process.exit(1);
    });
}
