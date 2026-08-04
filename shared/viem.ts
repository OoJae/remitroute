// Shared viem clients for Celo. Primary plus fallback RPC via the fallback
// transport, so a single RPC outage does not stop a heartbeat cycle.
import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { celo as celoBase } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

// Celo base fees can rise between fee estimation and block inclusion, so a
// transaction whose maxFeePerGas was computed a moment earlier gets rejected with
// "fee cap cannot be lower than the block base fee." viem's default 1.2x base-fee
// multiplier is too thin for that under fleet load (it caused ~35% of fleet txs to
// fail and tripped the breaker). Widen the cap so it survives normal movement.
// maxFeePerGas is only a ceiling and Celo charges the actual base fee, so a higher
// cap costs nothing while eliminating the transient rejections. The cast keeps the
// celo-specific type (feeCurrency support) intact.
const celo = {
  ...celoBase,
  fees: { ...celoBase.fees, baseFeeMultiplier: 3 },
} as typeof celoBase;

// Reads tolerate any Celo RPC, so they use the fallback pair and survive a single
// provider outage.
const readTransport = fallback([http(config.CELO_RPC), http(config.CELO_RPC_FALLBACK)]);

// Broadcasts do NOT use the fallback. Our transactions are CIP-64 (fee paid in a
// stablecoin via feeCurrency), and not every Celo RPC can decode that tx type: the
// configured fallback rejects eth_sendRawTransaction with "Missing or invalid
// parameters", which burned ~175 sends when the primary briefly faltered and viem
// failed over. Sending only through the primary means a primary outage delays a
// cycle instead of silently failing every broadcast against an incompatible node.
// Retries are viem's default per-transport behavior.
const writeTransport = http(config.CELO_RPC);

// Types are inferred so the celo-specific client (with feeCurrency support on
// transactions) is preserved. Annotating with the generic PublicClient/WalletClient
// would collapse that and break feeCurrency typing downstream.
export const publicClient = createPublicClient({ chain: celo, transport: readTransport });

// Build a wallet client bound to the agent account. Caller passes the private
// key (resolved through config or a decrypted sub-wallet key), so this module
// never reads the key itself.
export function walletClientFor(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: celo, transport: writeTransport });
}

// Explicit fee cap for CIP-64 fee-currency (stablecoin-gas) transactions. The
// chain-level baseFeeMultiplier above only feeds viem's native-CELO EIP-1559
// estimation; for a fee-currency send viem pins maxFeePerGas near the fee-currency
// gas price at estimate time with almost no headroom, so any upward tick before
// inclusion gets rejected with "fee cap cannot be lower than the block base fee"
// (this caused ~35% of fleet swaps to fail and auto-paused half the schedules).
// We set an explicit cap of twice the live gas price, floored at 60 gwei. This is
// the standard EIP-1559 headroom (base fee cannot rise 2x in the few blocks before
// inclusion, since each block caps its increase at 12.5%), so it clears the race.
// It is deliberately NOT larger: maxFeePerGas is a ceiling, but the node reserves
// gasLimit * maxFeePerGas of the fee currency up front, so an over-large cap makes
// small-balance agents fail estimation with "gas required exceeds allowance (0)".
// 2x wins the race while keeping that reservation affordable.
const FEE_CAP_FLOOR = 60_000_000_000n; // 60 gwei
const FEE_PRIORITY = 2_000_000_000n; // 2 gwei tip
export async function celoFeeOverrides(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  let cap = FEE_CAP_FLOOR;
  try {
    const live = await publicClient.getGasPrice();
    const scaled = live * 2n;
    if (scaled > cap) cap = scaled;
  } catch {
    // RPC hiccup: fall back to the floor, which already clears normal base fees.
  }
  const priority = FEE_PRIORITY < cap ? FEE_PRIORITY : cap;
  return { maxFeePerGas: cap, maxPriorityFeePerGas: priority };
}

export { celo };
