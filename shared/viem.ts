// Shared viem clients for Celo. Primary plus fallback RPC via the fallback
// transport, so a single RPC outage does not stop a heartbeat cycle.
import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

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
