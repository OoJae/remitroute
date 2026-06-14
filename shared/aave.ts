// Aave V3 helpers: minimal ABIs, the Pool resolved at runtime from the address
// provider (cached), and the approved-asset guard. The yield skill supplies and
// withdraws stablecoins here for savings sweeps.
import { publicClient } from "./viem.js";
import { AAVE, AAVE_APPROVED_ASSETS, type Hex } from "./addresses.js";

export const poolAddressesProviderAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export const aavePoolAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

// uint256 max, used to withdraw a user's full balance of a reserve.
export const MAX_UINT256 = (2n ** 256n - 1n) as bigint;

let poolCache: Hex | null = null;

// Resolve the live Aave V3 Pool address from the provider. Cached per process.
export async function resolvePool(): Promise<Hex> {
  if (poolCache) return poolCache;
  const pool = (await publicClient.readContract({
    address: AAVE.poolAddressesProvider,
    abi: poolAddressesProviderAbi,
    functionName: "getPool",
  })) as Hex;
  poolCache = pool;
  return pool;
}

// Reject any asset not on the approved reserve list.
export function assertApprovedAsset(symbol: string): void {
  if (!AAVE_APPROVED_ASSETS.has(symbol)) {
    throw new Error(`asset ${symbol} is not an approved Aave reserve for RemitRoute`);
  }
}
