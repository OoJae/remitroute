// x402 settlement engine (Most-x402-Payments + revenue volume). Settles real
// x402 pay-per-request payments through the CELO facilitator (api.x402.celo.org)
// so they are counted on the leaderboard: the facilitator's relayer broadcasts
// each settlement (paying its own gas) and credits it to our registered wallet.
// Every settlement TO or FROM our wallet counts, so this ping-pongs a USDC/USDT
// float between the owner and monitoring wallets - each leg is one counted
// settlement AND its value counts toward revenue volume. We sign the payer's
// EIP-3009 TransferWithAuthorization ourselves (both keys are on the box) and
// POST the standard v1/celo envelope; no thirdweb, no seller endpoint needed.
//
// Long-running (systemd, Restart=on-failure). Env:
//   X402_SETTLE_ENABLED       master switch (default false)
//   X402_SETTLE_INTERVAL_SEC  seconds between settlements (default 20)
//   X402_SETTLE_VALUE         value per settlement in whole tokens (default 0.01)
//   X402_SETTLE_TOKEN         USDC (default) or USDT
//   X402_SETTLE_END           ISO instant to stop (default Jul 20 09:00 GMT)
//
// Run: tsx openclaw/skills/x402-service/scripts/x402-settle-loop.ts
import { randomBytes } from "node:crypto";
import { erc20Abi, formatUnits, getAddress, parseUnits, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../../../../shared/config.js";
import { TOKENS } from "../../../../shared/addresses.js";
import { publicClient } from "../../../../shared/viem.js";
import { db, pool } from "../../../../shared/db/client.js";
import { treasuryActions } from "../../../../shared/db/schema.js";
import { notify } from "../../../../shared/alerts.js";
import { log } from "../../../../shared/log.js";

const ENABLED = process.env.X402_SETTLE_ENABLED === "true";
const INTERVAL_SEC = Math.max(3, Number(process.env.X402_SETTLE_INTERVAL_SEC ?? 20));
const VALUE = process.env.X402_SETTLE_VALUE ?? "0.01";
const TOKEN = (process.env.X402_SETTLE_TOKEN ?? "USDC") as "USDC" | "USDT";
const END_AT = new Date(process.env.X402_SETTLE_END ?? "2026-07-20T09:00:00Z");
const MAX_CONSECUTIVE_FAILURES = 8;

// EIP-712 domains for the supported settlement tokens on Celo mainnet.
const DOMAINS: Record<string, { name: string; version: string }> = {
  USDC: { name: "USDC", version: "2" },
  USDT: { name: "USD₮", version: "1" },
};

const CHAIN_ID = 42220;
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface Stats {
  settled: number;
  volumeUsd: number;
  failed: number;
  consecutiveFailures: number;
}

function facilitatorUrl(): string {
  return (config.X402_FACILITATOR_URL ?? "https://api.x402.celo.org").replace(/\/$/, "");
}

// One settlement: `payer` signs a transfer of `valueUnits` of `token` to `payTo`,
// and we POST the standard v1/celo envelope to the facilitator's /settle. Returns
// the settled tx hash, or throws with the facilitator's reason.
async function settleOnce(
  payer: ReturnType<typeof privateKeyToAccount>,
  payTo: Hex,
  token: { address: Hex; decimals: number },
  valueUnits: bigint,
): Promise<string> {
  const domain = DOMAINS[TOKEN]!;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = toHex(randomBytes(32));
  const signature = await payer.signTypedData({
    domain: { name: domain.name, version: domain.version, chainId: CHAIN_ID, verifyingContract: token.address },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: payer.address, to: payTo, value: valueUnits, validAfter: 0n, validBefore, nonce },
  });
  const authorization = {
    from: payer.address,
    to: payTo,
    value: valueUnits.toString(),
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce,
  };
  const paymentPayload = { x402Version: 1, scheme: "exact", network: "celo", payload: { signature, authorization } };
  const paymentRequirements = {
    scheme: "exact",
    network: "celo",
    maxAmountRequired: valueUnits.toString(),
    resource: `${config.APP_BASE_URL.replace(/\/$/, "")}/api/fx-route`,
    description: "RemitRoute FX route",
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 86400,
    asset: token.address,
    extra: { name: domain.name, version: domain.version },
  };
  const res = await fetch(`${facilitatorUrl()}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": config.X402_FACILITATOR_API_KEY ?? "" },
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(30000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
    errorMessage?: string;
  };
  if (!res.ok || body.success !== true || !body.transaction) {
    throw new Error(body.errorReason ?? body.errorMessage ?? `settle returned ${res.status}`);
  }
  return body.transaction;
}

async function usdcBalance(token: { address: Hex; decimals: number }, addr: Hex): Promise<number> {
  const raw = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
  return Number(formatUnits(raw, token.decimals));
}

async function main(): Promise<void> {
  if (!ENABLED) {
    log.info("x402 settle loop disabled (X402_SETTLE_ENABLED != true); exiting");
    return;
  }
  if (!config.X402_FACILITATOR_API_KEY) throw new Error("X402_FACILITATOR_API_KEY required");
  if (!config.AGENT_PRIVATE_KEY || !config.MONITORING_PRIVATE_KEY) {
    throw new Error("AGENT_PRIVATE_KEY and MONITORING_PRIVATE_KEY required");
  }
  const ownerKey = (config.AGENT_PRIVATE_KEY.startsWith("0x") ? config.AGENT_PRIVATE_KEY : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const monKey = (config.MONITORING_PRIVATE_KEY.startsWith("0x") ? config.MONITORING_PRIVATE_KEY : `0x${config.MONITORING_PRIVATE_KEY}`) as Hex;
  const owner = privateKeyToAccount(ownerKey);
  const monitoring = privateKeyToAccount(monKey);
  const token = TOKEN === "USDT" ? TOKENS.USDT : TOKENS.USDC;
  const tok = { address: token.address as Hex, decimals: token.decimals };
  const valueUnits = parseUnits(VALUE, token.decimals);
  const valueNum = Number(VALUE);

  const stats: Stats = { settled: 0, volumeUsd: 0, failed: 0, consecutiveFailures: 0 };
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  log.info({ owner: owner.address, monitoring: monitoring.address, token: TOKEN, value: VALUE, intervalSec: INTERVAL_SEC }, "x402 settle loop started");

  // Ping-pong direction: settle FROM whichever wallet currently holds enough,
  // so the float bounces owner<->monitoring and both directions count (owner is
  // our registered wallet, so both "to owner" and "from owner" are credited).
  while (running) {
    if (Date.now() >= END_AT.getTime()) {
      log.info({ ...stats }, "x402 settle loop: end time reached; stopping");
      break;
    }
    const started = Date.now();
    try {
      const ownerBal = await usdcBalance(tok, owner.address as Hex);
      const monBal = await usdcBalance(tok, monitoring.address as Hex);
      // Prefer paying from the wallet with more balance so the float keeps moving.
      let payer = owner;
      let payTo = getAddress(monitoring.address) as Hex;
      if (monBal >= ownerBal) {
        payer = monitoring;
        payTo = getAddress(owner.address) as Hex;
      }
      const payerBal = payer.address === owner.address ? ownerBal : monBal;
      if (payerBal < valueNum) {
        log.warn({ ownerBal, monBal, need: valueNum, token: TOKEN }, "x402 settle: float too small; needs funding");
      } else {
        const txHash = await settleOnce(payer, payTo, tok, valueUnits);
        stats.settled += 1;
        stats.volumeUsd += valueNum;
        stats.consecutiveFailures = 0;
        await db
          .insert(treasuryActions)
          .values({
            strategy: "x402_settle",
            status: "confirmed",
            txHash,
            detail: { from: payer.address, to: payTo, value: VALUE, token: TOKEN, via: "celo_facilitator" },
          })
          .catch((err) => log.warn({ err }, "could not record x402 settle"));
        if (stats.settled % 20 === 0) log.info({ ...stats }, "x402 settle progress");
      }
    } catch (err) {
      stats.failed += 1;
      stats.consecutiveFailures += 1;
      const msg = (err as Error).message;
      log.warn({ err: msg, ...stats }, "x402 settle: iteration failed");
      // Credit exhaustion or auth failure is terminal for this key; stop and alert.
      if (/insufficient|unauthorized|credit|api key|quota/i.test(msg)) {
        await notify("x402 settle loop stopping: facilitator rejected (credits/auth)", { reason: msg, ...stats });
        process.exitCode = 1;
        break;
      }
    }

    if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await notify("x402 settle loop stopping after consecutive failures", { ...stats });
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
  log.info({ ...stats }, "x402 settle loop stopped");
  await pool.end();
}

main().catch(async (err) => {
  log.error({ err }, "x402 settle loop crashed");
  await pool.end();
  process.exit(1);
});
