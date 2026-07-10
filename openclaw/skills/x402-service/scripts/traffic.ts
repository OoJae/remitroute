// x402 traffic engine: a steady loop of real pay-per-request x402 payments from
// the payer wallet (monitoring) to the live fx-route endpoint, settled onchain
// on Celo by our facilitator with the attribution suffix. Each iteration is one
// genuine x402 payment (EIP-3009 authorization signed by the payer, USDC moves
// payer -> payTo). USDC circulates payer -> owner, so the loop's real cost is
// only relayer gas; a capped top-up leg sends USDC back when the payer runs low.
//
// Long-running (systemd service, Restart=always). Tunables via .env:
//   X402_TRAFFIC_ENABLED       master switch (default false)
//   X402_TRAFFIC_INTERVAL_SEC  seconds between payments (default 60)
//   X402_TRAFFIC_END           ISO instant to stop at (default Jul 20 09:00 GMT,
//                              the hackathon counting deadline)
//
// Run: tsx openclaw/skills/x402-service/scripts/traffic.ts
import { createThirdwebClient } from "thirdweb";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { privateKeyToAccount, createWalletAdapter } from "thirdweb/wallets";
import { celo as thirdwebCelo } from "thirdweb/chains";
import { erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { config } from "../../../../shared/config.js";
import { TOKENS } from "../../../../shared/addresses.js";
import { publicClient, walletClientFor, celo } from "../../../../shared/viem.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { notify } from "../../../../shared/alerts.js";
import { log } from "../../../../shared/log.js";

// Payment loop tunables (env-read at startup; restart the service to change).
const ENABLED = process.env.X402_TRAFFIC_ENABLED === "true";
const INTERVAL_SEC = Math.max(5, Number(process.env.X402_TRAFFIC_INTERVAL_SEC ?? 60));
const END_AT = new Date(process.env.X402_TRAFFIC_END ?? "2026-07-20T09:00:00Z");

// Payer top-up guardrails: refill USDC owner -> payer when the payer cannot
// cover ~10 more calls; each refill is small and the daily total is hard-capped
// so a bug can never drain the owner's USDC. The refills are circular (payments
// send the same USDC payer -> owner), so the ceiling must cover a full day at
// the configured rate: ~0.01 USDC per payment = 864/day at a 100s interval.
// Env-tunable; the default self-sizes to the interval with 2x headroom.
const TOPUP_UNITS_PER = parseUnits("1", TOKENS.USDC.decimals); // 1 USDC per refill
const TOPUP_MAX_PER_DAY = Math.max(
  5,
  Number(process.env.X402_TOPUP_MAX_PER_DAY ?? Math.ceil(((86400 / INTERVAL_SEC) * 0.01) * 2)),
);
const PAYER_FLOOR_UNITS = parseUnits("0.1", TOKENS.USDC.decimals);

// Back off and let systemd restart us if the endpoint is persistently failing.
const MAX_CONSECUTIVE_FAILURES = 10;

interface Stats {
  ok: number;
  failed: number;
  topups: number;
  consecutiveFailures: number;
  topupsToday: number;
  topupDay: string;
}

function priceUnits(): bigint {
  const amountStr = config.X402_PRICE.replace(/[^0-9.]/g, "") || "0.01";
  return parseUnits(amountStr, TOKENS.USDC.decimals);
}

async function usdcBalance(addr: `0x${string}`): Promise<bigint> {
  return (await publicClient.readContract({
    address: TOKENS.USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
}

// Capped, tagged USDC refill from the owner wallet to the payer.
async function topUpPayer(payer: `0x${string}`, stats: Stats): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.topupDay !== today) {
    stats.topupDay = today;
    stats.topupsToday = 0;
  }
  if (stats.topupsToday >= TOPUP_MAX_PER_DAY) {
    log.warn({ topupsToday: stats.topupsToday }, "x402 traffic: daily top-up cap reached; waiting");
    return;
  }
  if (!config.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY (owner) required for top-up");
  const ownerBal = await usdcBalance(getAddress(config.AGENT_WALLET_ADDRESS!));
  if (ownerBal < TOPUP_UNITS_PER) {
    await notify("x402 traffic: owner USDC too low to refill the payer; loop will stall", {
      ownerBal: formatUnits(ownerBal, TOKENS.USDC.decimals),
    });
    return;
  }
  const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = walletClientFor(pk);
  const hash = await wallet.writeContract({
    address: TOKENS.USDC.address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [payer, TOPUP_UNITS_PER],
    feeCurrency: feeCurrencyAdapter(),
    dataSuffix: attributionSuffix(),
    account: wallet.account!,
    chain: celo,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  stats.topups += 1;
  stats.topupsToday += 1;
  log.info({ hash, payer }, "x402 traffic: payer topped up with 1 USDC");
}

async function main(): Promise<void> {
  if (!ENABLED) {
    log.info("x402 traffic disabled (X402_TRAFFIC_ENABLED != true); exiting");
    return;
  }
  if (!config.MONITORING_PRIVATE_KEY || !config.THIRDWEB_CLIENT_ID) {
    throw new Error("MONITORING_PRIVATE_KEY and THIRDWEB_CLIENT_ID are required");
  }

  const client = createThirdwebClient({ clientId: config.THIRDWEB_CLIENT_ID });
  const payerKey = (config.MONITORING_PRIVATE_KEY.startsWith("0x")
    ? config.MONITORING_PRIVATE_KEY
    : `0x${config.MONITORING_PRIVATE_KEY}`) as Hex;
  const account = privateKeyToAccount({ client, privateKey: payerKey });
  const wallet = createWalletAdapter({
    client,
    adaptedAccount: account,
    chain: thirdwebCelo,
    onDisconnect: () => {},
    switchChain: () => {},
  });
  // Authorize at most 1 USDC per call, far above the actual price.
  const fetchWithPayment = wrapFetchWithPayment(fetch, client, wallet, { maxValue: 1000000n });
  const payer = getAddress(account.address);

  // A 24/7 stable pair so a closed FX market can never 503 the loop (the route
  // quotes before it settles and refuses to charge when the quote fails).
  const url = `${config.APP_BASE_URL.replace(/\/$/, "")}/api/fx-route?tokenIn=cUSD&tokenOut=USDT&amountIn=1`;

  const stats: Stats = { ok: 0, failed: 0, topups: 0, consecutiveFailures: 0, topupsToday: 0, topupDay: "" };
  let running = true;
  process.on("SIGTERM", () => {
    running = false;
  });
  process.on("SIGINT", () => {
    running = false;
  });

  log.info({ payer, url, intervalSec: INTERVAL_SEC, endAt: END_AT.toISOString() }, "x402 traffic engine started");

  while (running) {
    if (Date.now() >= END_AT.getTime()) {
      log.info({ ...stats }, "x402 traffic: end time reached; stopping");
      break;
    }
    const started = Date.now();
    try {
      // Keep the payer funded ~10 calls ahead.
      const bal = await usdcBalance(payer);
      if (bal < PAYER_FLOOR_UNITS || bal < priceUnits() * 10n) {
        await topUpPayer(payer, stats);
      }

      const res = await fetchWithPayment(url);
      if (res.status === 200) {
        stats.ok += 1;
        stats.consecutiveFailures = 0;
        if (stats.ok % 10 === 0) {
          log.info({ ...stats }, "x402 traffic progress");
        }
      } else {
        stats.failed += 1;
        stats.consecutiveFailures += 1;
        const body = await res.text().catch(() => "");
        log.warn({ status: res.status, body: body.slice(0, 300), ...stats }, "x402 traffic: payment attempt failed");
      }
    } catch (err) {
      stats.failed += 1;
      stats.consecutiveFailures += 1;
      log.warn({ err, ...stats }, "x402 traffic: iteration error");
    }

    if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await notify("x402 traffic engine stopping after consecutive failures", { ...stats });
      process.exitCode = 1;
      break;
    }

    // Pace to the interval, accounting for the time the payment itself took.
    const elapsed = Date.now() - started;
    const waitMs = Math.max(0, INTERVAL_SEC * 1000 - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  log.info({ ...stats }, "x402 traffic engine stopped");
}

main().catch((err) => {
  log.error({ err }, "x402 traffic engine crashed");
  process.exit(1);
});
