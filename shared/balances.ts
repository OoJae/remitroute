// Read an execution wallet's idle token balances for the Mini App balance view
// and the withdraw flow. Pure reads through the shared public client; no keys.
import { erc20Abi, formatUnits } from "viem";
import { publicClient } from "./viem.js";
import { resolveToken } from "./addresses.js";

export interface TokenBalance {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  amount: string;
}

// Balances of the given token symbols for one wallet. Unknown symbols are
// skipped. Amounts are formatted whole-unit strings (e.g. "1.250000").
export async function executionWalletBalances(
  walletAddress: string,
  symbols: string[],
): Promise<TokenBalance[]> {
  const out: TokenBalance[] = [];
  for (const symbol of symbols) {
    const token = resolveToken(symbol);
    const raw = (await publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    })) as bigint;
    out.push({
      symbol,
      address: token.address,
      decimals: token.decimals,
      amount: formatUnits(raw, token.decimals),
    });
  }
  return out;
}
