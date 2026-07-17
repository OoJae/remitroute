// Recycle USDC back to the fleet's x402 payers.
//
// An agent pays for a priced FX route in USDC, and the payment goes to our own
// payTo (the owner wallet), so the float loops home. Without this, each agent
// simply bleeds its seed down and stops buying routes after ~50 calls; with it, a
// few dollars circulate for the whole run.
//
// The daily ceiling is counted in the treasury ledger rather than in memory,
// because the heartbeat is a systemd oneshot: a process-local counter would reset
// every cycle and the cap would mean nothing. It is deliberately FLEET-GLOBAL
// (not per payer), so twelve agents cannot multiply the ceiling by twelve. This
// mirrors how the ODIS quota top-up bounds itself.
import { erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { treasuryActions } from "./db/schema.js";
import { config } from "./config.js";
import { publicClient, walletClientFor, celo } from "./viem.js";
import { feeCurrencyAdapter } from "./feeCurrency.js";
import { attributionSuffix } from "./attribution.js";
import { resolveToken } from "./addresses.js";
import { log } from "./log.js";

// Below this a payer can no longer reliably buy a route (price is 0.01).
const FLOOR_USDC = Number(process.env.X402_PAYER_FLOOR_USDC ?? 0.05);
// One refill buys ~25 routes.
const REFILL_USDC = Number(process.env.X402_REFILL_USDC ?? 0.25);
// Fleet-global refills per UTC day. At 0.25 each this bounds the recycled float
// to a known figure no matter how the fleet behaves.
const MAX_TOPUPS_PER_DAY = Number(process.env.X402_TOPUP_MAX_PER_DAY ?? 40);

async function usdcBalance(address: string): Promise<number> {
  const token = resolveToken("USDC");
  const raw = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  })) as bigint;
  return Number(formatUnits(raw, token.decimals));
}

// Top a payer back up when it dips below the floor. Best effort: never throws
// into the caller's money path, since a failed refill just means the agent buys
// no route this cycle.
export async function topUpPayerIfLow(payer: string): Promise<void> {
  try {
    const bal = await usdcBalance(payer);
    if (bal >= FLOOR_USDC) return;

    const counted = await db.execute(
      sql`select count(*)::int n from treasury_actions
          where strategy = ${"x402_topup"} and status = ${"confirmed"}
            and created_at >= date_trunc('day', now() at time zone 'utc')`,
    );
    const used = Number((counted.rows ?? counted)[0]?.n ?? 0);
    if (used >= MAX_TOPUPS_PER_DAY) {
      log.warn({ used, cap: MAX_TOPUPS_PER_DAY }, "x402 topup: fleet daily cap reached");
      return;
    }

    if (!config.AGENT_PRIVATE_KEY || !config.AGENT_WALLET_ADDRESS) return;
    const ownerBal = await usdcBalance(config.AGENT_WALLET_ADDRESS);
    if (ownerBal < REFILL_USDC) {
      log.warn({ ownerBal, need: REFILL_USDC }, "x402 topup: owner USDC exhausted; agents will buy no routes");
      return;
    }

    const token = resolveToken("USDC");
    const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
      ? config.AGENT_PRIVATE_KEY
      : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
    const wallet = walletClientFor(pk);
    const hash = await wallet.writeContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(payer), parseUnits(REFILL_USDC.toFixed(6), token.decimals)],
      feeCurrency: feeCurrencyAdapter(),
      dataSuffix: attributionSuffix(),
      account: wallet.account!,
      chain: celo,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    await db
      .insert(treasuryActions)
      .values({
        strategy: "x402_topup",
        status,
        txHash: hash,
        detail: { payer, amount: REFILL_USDC.toFixed(6), token: "USDC", was: bal },
      })
      .catch(() => {});
    log.info({ payer, amount: REFILL_USDC, status }, "x402 topup: recycled USDC back to payer");
  } catch (err) {
    log.warn({ err: (err as Error).message, payer }, "x402 topup failed; agent will buy no route this cycle");
  }
}
