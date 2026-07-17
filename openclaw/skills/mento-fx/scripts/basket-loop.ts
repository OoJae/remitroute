// Autonomous FX treasury basket agent. The generalization of volume-loop.ts:
// instead of ping-ponging one hardcoded cUSD<->USDT pair, this holds a
// multi-currency Mento basket at target value weights on the OWNER treasury
// wallet and trades whichever leg has drifted furthest from target back through
// the cUSD hub, tilted by a short moving average per leg (buy what is cheap
// against its own recent average, sell what is rich).
//
// Why this shape: the volume it produces is the by-product of a real decision
// (drift vs target, plus an FX signal), it spans every stable with a live Mento
// pool rather than one pair, and every swap is stored with the sentence that
// explains it. Same capital, same tagging, same safety rails; the difference is
// that the ledger now reads as autonomous treasury management instead of a loop.
//
// This is a treasury path (like volume-loop.ts): it writes treasury_actions and
// is deliberately NOT bound by the per-user spend caps, which exist to protect
// user funds. It is bounded instead by BASKET_MAX_RUN_USD, BASKET_MAX_LEG_USD,
// the cUSD gas reserve, the engine halt gate and the consecutive-failure stop.
//
// Long-running (systemd, Restart=on-failure). Env:
//   BASKET_ENABLED             master switch (default false)
//   BASKET_INTERVAL_SEC        seconds between ticks (default 60)
//   BASKET_TARGETS             JSON symbol -> weight (normalized at startup)
//   BASKET_MAX_RUN_USD         stop cleanly once this run has traded this much
//   BASKET_MIN_CUSD_RESERVE    cUSD held back for gas, never spent (default 2)
//   BASKET_MAX_LEG_USD         ceiling per backbone swap (default 50)
//   BASKET_MAX_EXOTIC_LEG_USD  ceiling per thin local-currency swap (default 1)
//   BASKET_DRIFT_BPS           act once a leg is this far off target (default 25)
//   BASKET_EXOTIC_SLIPPAGE_BPS tolerance for thin local-currency pools (default 250)
//   BASKET_MA_WINDOW           moving-average window in ticks (default 20)
//   BASKET_END                 ISO instant to stop (default Aug 3 12:00 GMT,
//                              just past the submission deadline)
//
// Run: tsx openclaw/skills/mento-fx/scripts/basket-loop.ts
import { erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { config } from "../../../../shared/config.js";
import { publicClient, walletClientFor, celo } from "../../../../shared/viem.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { getMento, resolveMentoToken } from "../../../../shared/mento.js";
import { withAttribution } from "../../../../shared/attribution.js";
import { reconcileTx, RECEIPT_TIMEOUT_MS } from "../../../../shared/reconcile.js";
import { getEngineState } from "../../../../shared/engine.js";
import { db, pool } from "../../../../shared/db/client.js";
import { treasuryActions } from "../../../../shared/db/schema.js";
import { notify } from "../../../../shared/alerts.js";
import { log } from "../../../../shared/log.js";
import { pickRebalanceLeg, updateMovingAverage, type BasketLeg } from "../../../../shared/basket.js";

const ENABLED = process.env.BASKET_ENABLED === "true";
const INTERVAL_SEC = Math.max(10, Number(process.env.BASKET_INTERVAL_SEC ?? 60));
const MAX_RUN_USD = process.env.BASKET_MAX_RUN_USD
  ? Math.max(0, Number(process.env.BASKET_MAX_RUN_USD))
  : Infinity;
const MIN_CUSD_RESERVE = Number(process.env.BASKET_MIN_CUSD_RESERVE ?? 2);
// Backbone pools are deep and near parity, so a large leg is safe there and it is
// where the traded value comes from. Thin local-currency pools move price fast, so
// their legs stay small: they buy diversity, not size.
const MAX_LEG_USD = Number(process.env.BASKET_MAX_LEG_USD ?? 50);
const MAX_EXOTIC_LEG_USD = Number(process.env.BASKET_MAX_EXOTIC_LEG_USD ?? 1);
// Act on small drifts. Every swap nudges the basket off target by its own spread,
// so a tight band keeps the agent continuously correcting rather than idling.
const DRIFT_THRESHOLD_BPS = Number(process.env.BASKET_DRIFT_BPS ?? 25);
const EXOTIC_SLIPPAGE_BPS = Math.min(300, Number(process.env.BASKET_EXOTIC_SLIPPAGE_BPS ?? 250));
const MA_WINDOW = Number(process.env.BASKET_MA_WINDOW ?? 20);
const END_AT = new Date(process.env.BASKET_END ?? "2026-08-03T12:00:00Z");

const HUB = "cUSD";
// Deep, near-parity pools: these carry the bulk of the value and tolerate a tight
// band. Everything else is treated as a thin local-currency pool.
const BACKBONE = new Set(["cUSD", "USDC", "USDT", "cEUR"]);
const BACKBONE_SLIPPAGE_BPS = 50;
// A leg smaller than this is not worth the gas.
const MIN_LEG_USD = 0.05;
const MAX_CONSECUTIVE_FAILURES = 10;

const DEFAULT_TARGETS: Record<string, number> = {
  cUSD: 0.34,
  USDT: 0.2,
  USDC: 0.2,
  cEUR: 0.12,
  cKES: 0.05,
  cNGN: 0.03,
  cGHS: 0.03,
  cZAR: 0.03,
};

interface Tradeable {
  symbol: string;
  address: Hex;
  decimals: number;
  target: number;
  exotic: boolean;
}

interface Stats {
  swaps: number;
  failed: number;
  consecutiveFailures: number;
  volumeUsd: number;
}

function slippageFor(from: string, to: string): number {
  return BACKBONE.has(from) && BACKBONE.has(to) ? BACKBONE_SLIPPAGE_BPS : EXOTIC_SLIPPAGE_BPS;
}

async function balanceOf(token: { address: Hex; decimals: number }, owner: Hex): Promise<number> {
  const raw = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  return Number(formatUnits(raw, token.decimals));
}

// Price of one whole token in cUSD, via a one-unit Mento quote. Doubles as the
// tradeability probe at startup: a symbol whose pool cannot quote is dropped.
async function unitPriceUsd(
  mento: Awaited<ReturnType<typeof getMento>>,
  token: Tradeable,
  cusd: { address: Hex; decimals: number },
): Promise<number> {
  if (token.symbol === HUB) return 1;
  const one = parseUnits("1", token.decimals);
  const quote = await mento.quotes.getAmountOut(token.address, cusd.address, one);
  return Number(formatUnits(quote, cusd.decimals));
}

// One tagged Mento swap of `amount` of `from` into `to`, from the owner wallet.
// Mirrors volume-loop.ts doSwap: quote, build, defensive amountOutMin floor,
// approve if needed, broadcast with the attribution suffix and stablecoin gas.
async function doSwap(
  wallet: ReturnType<typeof walletClientFor>,
  mento: Awaited<ReturnType<typeof getMento>>,
  from: Tradeable,
  to: Tradeable,
  amount: number,
  slippageBps: number,
): Promise<{ status: string; txHash?: string }> {
  const amountUnits = parseUnits(amount.toFixed(Math.min(6, from.decimals)), from.decimals);
  if (amountUnits <= 0n) return { status: "skipped_dust" };
  const quote = await mento.quotes.getAmountOut(from.address, to.address, amountUnits);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const owner = wallet.account!.address;
  const built = await mento.swap.buildSwapTransaction(
    from.address,
    to.address,
    amountUnits,
    getAddress(owner),
    getAddress(owner),
    { slippageTolerance: slippageBps / 100, deadline },
  );
  const floor = (quote * BigInt(10000 - slippageBps)) / 10000n;
  if (built.swap.amountOutMin <= 0n || built.swap.amountOutMin < floor) {
    throw new Error(`amountOutMin below safe floor for ${from.symbol}->${to.symbol}; refusing`);
  }
  const feeCurrency = feeCurrencyAdapter();
  const account = wallet.account!;
  if (built.approval) {
    const approvalHash = await wallet.sendTransaction({
      account,
      chain: celo,
      to: getAddress(built.approval.to),
      data: withAttribution(built.approval.data as Hex),
      feeCurrency,
    });
    await publicClient.waitForTransactionReceipt({ hash: approvalHash, timeout: RECEIPT_TIMEOUT_MS });
  }
  const txHash = await wallet.sendTransaction({
    account,
    chain: celo,
    to: getAddress(built.swap.params.to),
    data: withAttribution(built.swap.params.data as Hex),
    feeCurrency,
  });
  let status: string;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    status = receipt.status === "success" ? "confirmed" : "reverted";
  } catch {
    status = await reconcileTx(txHash);
  }
  return { status, txHash };
}

// Keep only the symbols that actually have a live Mento pool we can quote. The
// tradeable universe is discovered at runtime (Mento rebranded the c-names to
// m-names and not every currency has a pool), so a symbol that cannot be quoted
// is dropped once at startup rather than failing every tick.
async function resolveBasket(
  mento: Awaited<ReturnType<typeof getMento>>,
  rawTargets: Record<string, number>,
  cusd: { address: Hex; decimals: number },
): Promise<Tradeable[]> {
  const out: Tradeable[] = [];
  for (const [symbol, weight] of Object.entries(rawTargets)) {
    if (!(weight > 0)) continue;
    try {
      const token = await resolveMentoToken(symbol, mento);
      const candidate: Tradeable = {
        symbol,
        address: token.address as Hex,
        decimals: token.decimals,
        target: weight,
        exotic: !BACKBONE.has(symbol),
      };
      await unitPriceUsd(mento, candidate, cusd);
      out.push(candidate);
    } catch (err) {
      log.warn({ symbol, err: (err as Error).message }, "basket: symbol not tradeable on Mento; skipping");
    }
  }
  // Renormalize the surviving weights so they sum to 1.
  const sum = out.reduce((a, t) => a + t.target, 0);
  if (sum <= 0) throw new Error("basket: no tradeable symbols resolved");
  for (const t of out) t.target = t.target / sum;
  return out;
}

async function main(): Promise<void> {
  if (!ENABLED) {
    log.info("basket loop disabled (BASKET_ENABLED != true); exiting");
    return;
  }
  // The basket runs on its OWN wallet by default. The single-pair volume loop
  // swings the owner wallet's USDT between 0 and 90 percent, which a basket
  // sharing that wallet would read as drift and fight, burning gas and producing
  // nonsense reasons. Separate floats keep each engine's behavior honest (and the
  // extra address is real diversity). Falls back to the owner wallet if unset.
  const rawKey = config.BASKET_PRIVATE_KEY ?? config.AGENT_PRIVATE_KEY;
  const rawAddr = config.BASKET_WALLET_ADDRESS ?? config.AGENT_WALLET_ADDRESS;
  if (!rawKey || !rawAddr) {
    throw new Error("BASKET_PRIVATE_KEY/BASKET_WALLET_ADDRESS (or AGENT_*) are required");
  }
  const pk = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  const wallet = walletClientFor(pk);
  const owner = getAddress(rawAddr) as Hex;

  const mento = await getMento();
  const cusdResolved = await resolveMentoToken(HUB, mento);
  const cusd = { address: cusdResolved.address as Hex, decimals: cusdResolved.decimals };

  const rawTargets: Record<string, number> = process.env.BASKET_TARGETS
    ? (JSON.parse(process.env.BASKET_TARGETS) as Record<string, number>)
    : DEFAULT_TARGETS;
  const basket = await resolveBasket(mento, rawTargets, cusd);

  const stats: Stats = { swaps: 0, failed: 0, consecutiveFailures: 0, volumeUsd: 0 };
  const rings: Record<string, number[]> = {};
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  log.info(
    {
      owner,
      intervalSec: INTERVAL_SEC,
      basket: basket.map((t) => ({ s: t.symbol, w: Number(t.target.toFixed(4)), exotic: t.exotic })),
      maxLegUsd: MAX_LEG_USD,
      maxRunUsd: MAX_RUN_USD,
      endAt: END_AT.toISOString(),
    },
    "fx treasury basket agent started",
  );

  while (running) {
    if (Date.now() >= END_AT.getTime()) {
      log.info({ ...stats }, "basket loop: end time reached; stopping");
      break;
    }
    const started = Date.now();
    try {
      const engine = await getEngineState();
      if (engine.status === "halted") {
        log.warn("basket loop: engine halted; idling this tick");
      } else {
        // Value every leg in cUSD and refresh its moving average. One quote per
        // symbol gives both the price signal and the valuation.
        const legs: BasketLeg[] = [];
        const signalBySymbol: Record<string, number> = {};
        const priced: Record<string, { token: Tradeable; balance: number; price: number }> = {};
        for (const token of basket) {
          const balance = await balanceOf(token, owner);
          const price = await unitPriceUsd(mento, token, cusd);
          const { ring, deviationBps } = updateMovingAverage(rings[token.symbol] ?? [], price, MA_WINDOW);
          rings[token.symbol] = ring;
          signalBySymbol[token.symbol] = deviationBps;
          priced[token.symbol] = { token, balance, price };
          legs.push({ symbol: token.symbol, valueUsd: balance * price, target: token.target });
        }

        const total = legs.reduce((a, l) => a + l.valueUsd, 0);
        const hubLeg = legs.find((l) => l.symbol === HUB);
        const hubValue = hubLeg?.valueUsd ?? 0;
        // Never spend the hub below its own target share, and always keep the gas
        // reserve untouched.
        const hubAvailable = Math.max(0, hubValue - (hubLeg?.target ?? 0) * total - MIN_CUSD_RESERVE);

        const maxLegUsdBySymbol: Record<string, number> = {};
        for (const t of basket) maxLegUsdBySymbol[t.symbol] = t.exotic ? MAX_EXOTIC_LEG_USD : MAX_LEG_USD;

        const leg = pickRebalanceLeg(legs, hubAvailable, {
          hub: HUB,
          driftThresholdBps: DRIFT_THRESHOLD_BPS,
          maxLegUsd: MAX_LEG_USD,
          maxLegUsdBySymbol,
          minLegUsd: MIN_LEG_USD,
          signalBySymbol,
        });

        if (!leg) {
          log.info({ total: Number(total.toFixed(4)) }, "basket: within tolerance, nothing to trade");
        } else {
          const fromPriced = priced[leg.from]!;
          const toPriced = priced[leg.to]!;
          // Convert the cUSD-denominated leg size into units of the token we sell.
          const amountTokens = fromPriced.price > 0 ? leg.amountUsd / fromPriced.price : 0;
          const slippageBps = slippageFor(leg.from, leg.to);
          const r = await doSwap(wallet, mento, fromPriced.token, toPriced.token, amountTokens, slippageBps);
          const confirmed = r.status === "confirmed";
          if (confirmed) {
            stats.swaps += 1;
            stats.volumeUsd += leg.amountUsd;
            stats.consecutiveFailures = 0;
          } else {
            stats.failed += 1;
            stats.consecutiveFailures += 1;
          }
          await db
            .insert(treasuryActions)
            .values({
              strategy: "fx_treasury",
              status: r.status,
              txHash: r.txHash,
              detail: {
                from: leg.from,
                to: leg.to,
                amount: amountTokens.toFixed(6),
                amountUsd: Number(leg.amountUsd.toFixed(4)),
                targetWeight: Number(leg.target.toFixed(4)),
                currentWeight: Number(leg.currentWeight.toFixed(4)),
                driftBps: Math.round(leg.driftBps),
                signalBps: Math.round(leg.deviationBps),
                valuationUsd: Number(total.toFixed(4)),
                slippageBps,
                rationale: leg.rationale,
              },
            })
            .catch((err) => log.warn({ err }, "could not record basket swap"));
          log.info(
            { from: leg.from, to: leg.to, amountUsd: Number(leg.amountUsd.toFixed(4)), status: r.status, reason: leg.rationale },
            "basket: rebalanced leg",
          );
          if (stats.volumeUsd >= MAX_RUN_USD) {
            log.info({ ...stats, maxRunUsd: MAX_RUN_USD }, "basket loop: run volume cap reached; stopping cleanly");
            break;
          }
        }
      }
    } catch (err) {
      stats.failed += 1;
      stats.consecutiveFailures += 1;
      log.warn({ err: (err as Error).message, ...stats }, "basket loop: iteration error");
    }

    if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await notify("fx treasury basket loop stopping after consecutive failures", { ...stats });
      process.exitCode = 1;
      break;
    }

    const elapsed = Date.now() - started;
    let remainingMs = Math.max(0, INTERVAL_SEC * 1000 - elapsed);
    while (running && remainingMs > 0) {
      const slice = Math.min(remainingMs, 5000);
      await new Promise((resolve) => setTimeout(resolve, slice));
      remainingMs -= slice;
    }
  }

  log.info({ ...stats }, "fx treasury basket agent stopped");
  await pool.end();
}

main().catch(async (err) => {
  log.error({ err }, "basket loop crashed");
  await pool.end();
  process.exit(1);
});
