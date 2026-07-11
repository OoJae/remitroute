// Tagged on-chain volume engine (Most-Revenue track). A steady cUSD<->USDT Mento
// swap loop on the OWNER wallet: it ping-pongs a working float back and forth, so
// the SAME capital is counted as volume over and over. cUSD<->USDT is a 24/7
// USD-stable pair with a near-zero spread, so the loop's real cost is only the
// tiny Mento spread plus gas (paid in cUSD). Every swap carries the attribution
// suffix, so it registers as RemitRoute volume on the leaderboard. This is a
// treasury tool (like the x402 traffic loop), separate from the per-user capped
// money paths; it moves only the agent's own float.
//
// Long-running (systemd, Restart=on-failure). Env:
//   VOLUME_ENABLED           master switch (default false)
//   VOLUME_INTERVAL_SEC      seconds between swaps (default 60)
//   VOLUME_SWAP_FRACTION     fraction of the source balance per swap (default 0.9)
//   VOLUME_MIN_CUSD_RESERVE  cUSD held back for gas, never swapped (default 2)
//   VOLUME_END               ISO instant to stop (default Jul 20 09:00 GMT)
//
// Run: tsx openclaw/skills/mento-fx/scripts/volume-loop.ts
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

const ENABLED = process.env.VOLUME_ENABLED === "true";
const INTERVAL_SEC = Math.max(10, Number(process.env.VOLUME_INTERVAL_SEC ?? 60));
const SWAP_FRACTION = Math.min(0.95, Math.max(0.1, Number(process.env.VOLUME_SWAP_FRACTION ?? 0.9)));
const MIN_CUSD_RESERVE = Number(process.env.VOLUME_MIN_CUSD_RESERVE ?? 2);
const END_AT = new Date(process.env.VOLUME_END ?? "2026-07-20T09:00:00Z");

// Below this (in whole tokens) a side is too small to bother swapping.
const DUST = 0.5;
// Defensive slippage floor for the stable pair (0.5%); a stable-stable swap
// should never move more than a few bps, so a larger deviation is a bad quote.
const MAX_SLIPPAGE_BPS = 50;
const MAX_CONSECUTIVE_FAILURES = 10;

interface Stats {
  swaps: number;
  failed: number;
  consecutiveFailures: number;
  volumeUsd: number;
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

// One tagged Mento swap of `amount` of `from` into `to`, from the owner wallet.
// Returns the USD-equivalent volume (the input amount, since both legs are ~$1).
async function doSwap(
  wallet: ReturnType<typeof walletClientFor>,
  mento: Awaited<ReturnType<typeof getMento>>,
  from: { symbol: string; address: Hex; decimals: number },
  to: { symbol: string; address: Hex; decimals: number },
  amount: number,
): Promise<{ status: string; txHash?: string; volumeUsd: number }> {
  const amountUnits = parseUnits(amount.toFixed(6), from.decimals);
  const quote = await mento.quotes.getAmountOut(from.address, to.address, amountUnits);
  const deadline = BigInt(Math.floor(END_AT.getTime() / 1000)); // any future instant; the loop stops at END_AT
  const owner = wallet.account!.address;
  const built = await mento.swap.buildSwapTransaction(
    from.address,
    to.address,
    amountUnits,
    getAddress(owner),
    getAddress(owner),
    { slippageTolerance: MAX_SLIPPAGE_BPS / 100, deadline },
  );
  const floor = (quote * BigInt(10000 - MAX_SLIPPAGE_BPS)) / 10000n;
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
  await db
    .insert(treasuryActions)
    .values({
      strategy: "volume_swap",
      status,
      txHash,
      detail: { from: from.symbol, to: to.symbol, amount: amount.toFixed(6) },
    })
    .catch((err) => log.warn({ err }, "could not record volume swap"));
  return { status, txHash, volumeUsd: status === "confirmed" ? amount : 0 };
}

async function main(): Promise<void> {
  if (!ENABLED) {
    log.info("volume loop disabled (VOLUME_ENABLED != true); exiting");
    return;
  }
  if (!config.AGENT_PRIVATE_KEY || !config.AGENT_WALLET_ADDRESS) {
    throw new Error("AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS (owner) are required");
  }
  const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = walletClientFor(pk);
  const owner = getAddress(config.AGENT_WALLET_ADDRESS) as Hex;
  const mento = await getMento();
  const cusd = await resolveMentoToken("cUSD", mento);
  const usdt = await resolveMentoToken("USDT", mento);
  const cUSD = { symbol: "cUSD", address: cusd.address as Hex, decimals: cusd.decimals };
  const USDT = { symbol: "USDT", address: usdt.address as Hex, decimals: usdt.decimals };

  const stats: Stats = { swaps: 0, failed: 0, consecutiveFailures: 0, volumeUsd: 0 };
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  log.info({ owner, intervalSec: INTERVAL_SEC, endAt: END_AT.toISOString(), fraction: SWAP_FRACTION }, "volume loop started");

  while (running) {
    if (Date.now() >= END_AT.getTime()) {
      log.info({ ...stats }, "volume loop: end time reached; stopping");
      break;
    }
    const started = Date.now();
    try {
      // Never move money while the operator has halted the engine.
      const engine = await getEngineState();
      if (engine.status === "halted") {
        log.warn("volume loop: engine halted; idling this tick");
      } else {
        const cusdBal = await balanceOf(cUSD, owner);
        const usdtBal = await balanceOf(USDT, owner);
        // Swap the larger side down, always keeping a cUSD gas reserve. This
        // ping-pongs the float and never overdraws or starves gas.
        const cusdSwappable = cusdBal - MIN_CUSD_RESERVE;
        let leg: { from: typeof cUSD; to: typeof cUSD; amount: number } | null = null;
        if (cusdSwappable >= usdtBal && cusdSwappable > DUST) {
          leg = { from: cUSD, to: USDT, amount: cusdSwappable * SWAP_FRACTION };
        } else if (usdtBal > DUST) {
          leg = { from: USDT, to: cUSD, amount: usdtBal * SWAP_FRACTION };
        }
        if (!leg) {
          log.warn({ cusdBal, usdtBal }, "volume loop: float too small to swap; needs funding");
        } else {
          const r = await doSwap(wallet, mento, leg.from, leg.to, leg.amount);
          if (r.status === "confirmed") {
            stats.swaps += 1;
            stats.volumeUsd += r.volumeUsd;
            stats.consecutiveFailures = 0;
            if (stats.swaps % 10 === 0) log.info({ ...stats }, "volume loop progress");
          } else {
            stats.failed += 1;
            stats.consecutiveFailures += 1;
            log.warn({ status: r.status, ...leg, txHash: r.txHash }, "volume loop: swap not confirmed");
          }
        }
      }
    } catch (err) {
      stats.failed += 1;
      stats.consecutiveFailures += 1;
      log.warn({ err, ...stats }, "volume loop: iteration error");
    }

    if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await notify("volume loop stopping after consecutive failures", { ...stats });
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
  log.info({ ...stats }, "volume loop stopped");
  await pool.end();
}

main().catch(async (err) => {
  log.error({ err }, "volume loop crashed");
  await pool.end();
  process.exit(1);
});
