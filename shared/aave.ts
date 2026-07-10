// Aave V3 helpers: minimal ABIs, the Pool resolved at runtime from the address
// provider (cached), the approved-asset guard, and read-only position/APY
// queries for the Mini App savings display. The yield skill supplies and
// withdraws stablecoins here for savings sweeps.
import { erc20Abi, formatUnits } from "viem";
import { publicClient } from "./viem.js";
import { AAVE, AAVE_APPROVED_ASSETS, type Hex } from "./addresses.js";
import { resolveToken } from "./addresses.js";
import { apyFromRay } from "./yieldMath.js";

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
  // Read-only reserve state; currentLiquidityRate (ray) is the live supply APR
  // and aTokenAddress is the interest-bearing receipt token whose balanceOf is
  // the user's supplied position including accrued interest.
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
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

export interface AavePosition {
  symbol: string;
  // Whole-unit supplied balance (principal + accrued interest), from the aToken.
  supplied: string;
  suppliedNum: number;
  apyPct: number;
}

interface ReserveMeta {
  aToken: Hex;
  rateRay: bigint;
  decimals: number;
  fetchedAt: number;
}

// Reserve data changes slowly (rates move with utilization); cache briefly so
// the balance endpoint stays a handful of RPC reads.
const RESERVE_TTL_MS = 60_000;
const reserveCache = new Map<string, ReserveMeta>();

async function reserveMeta(symbol: string): Promise<ReserveMeta | null> {
  const hit = reserveCache.get(symbol);
  if (hit && Date.now() - hit.fetchedAt < RESERVE_TTL_MS) return hit;
  try {
    const token = resolveToken(symbol);
    const pool = await resolvePool();
    const data = (await publicClient.readContract({
      address: pool,
      abi: aavePoolAbi,
      functionName: "getReserveData",
      args: [token.address],
    })) as { currentLiquidityRate: bigint; aTokenAddress: Hex };
    const meta: ReserveMeta = {
      aToken: data.aTokenAddress,
      rateRay: data.currentLiquidityRate,
      decimals: token.decimals,
      fetchedAt: Date.now(),
    };
    reserveCache.set(symbol, meta);
    return meta;
  } catch {
    return null; // asset without a live reserve: simply no position to show
  }
}

// The wallet's live Aave positions across the approved reserves: supplied
// balance (aToken balanceOf = principal + interest) and the current supply APY.
// Read-only; zero positions are skipped.
export async function aavePositions(wallet: Hex, symbols?: string[]): Promise<AavePosition[]> {
  const list = symbols ?? [...AAVE_APPROVED_ASSETS];
  const out: AavePosition[] = [];
  for (const symbol of list) {
    const meta = await reserveMeta(symbol);
    if (!meta) continue;
    const raw = (await publicClient.readContract({
      address: meta.aToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;
    if (raw === 0n) continue;
    const supplied = formatUnits(raw, meta.decimals);
    out.push({ symbol, supplied, suppliedNum: Number(supplied), apyPct: apyFromRay(meta.rateRay) });
  }
  return out;
}
