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

const transport = fallback([http(config.CELO_RPC), http(config.CELO_RPC_FALLBACK)]);

// Types are inferred so the celo-specific client (with feeCurrency support on
// transactions) is preserved. Annotating with the generic PublicClient/WalletClient
// would collapse that and break feeCurrency typing downstream.
export const publicClient = createPublicClient({ chain: celo, transport });

// Build a wallet client bound to the agent account. Caller passes the private
// key (resolved through config or a decrypted sub-wallet key), so this module
// never reads the key itself.
export function walletClientFor(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: celo, transport });
}

export { celo };
