// Shared Mento helpers: a cached Mento SDK instance and token-symbol resolution.
// Mento rebranded its stablecoins from the c-prefix to an m-suffix on-chain
// symbol (cKES is now KESm). We accept the brief's c-names and the new m-names;
// both resolve to the same live token discovered from the Mento pools at runtime.
import { erc20Abi, getAddress, type Hex } from "viem";
import { Mento } from "@mento-protocol/mento-sdk";
import { publicClient } from "./viem.js";
import { CELO_CHAIN_ID, TOKENS } from "./addresses.js";
import { log } from "./log.js";

export interface ResolvedToken {
  address: Hex;
  decimals: number;
}

export const MENTO_SYMBOL_ALIASES: Record<string, string> = {
  cUSD: "USDm",
  cEUR: "EURm",
  cKES: "KESm",
  cNGN: "NGNm",
  cGHS: "GHSm",
  cZAR: "ZARm",
  cGBP: "GBPm",
  cJPY: "JPYm",
  cCAD: "CADm",
  cAUD: "AUDm",
  cCHF: "CHFm",
  cCOP: "COPm",
  cREAL: "BRLm",
  PUSO: "PHPm",
  eXOF: "XOFm",
};

let mentoInstance: Mento | null = null;

// Cached Mento SDK instance bound to our celo public client.
export async function getMento(): Promise<Mento> {
  if (mentoInstance) return mentoInstance;
  // Our publicClient is celo-typed (feeCurrency-aware), structurally a valid
  // viem PublicClient but nominally distinct from the SDK's bundled viem. Cast;
  // runtime behavior is identical.
  mentoInstance = await Mento.create(
    CELO_CHAIN_ID,
    publicClient as unknown as Parameters<typeof Mento.create>[1],
  );
  return mentoInstance;
}

let tokenCache: Map<string, ResolvedToken> | null = null;

async function buildMentoTokenMap(mento: Mento): Promise<Map<string, ResolvedToken>> {
  if (tokenCache) return tokenCache;
  const pools = await mento.pools.getPools();
  const addrs = new Set<string>();
  for (const p of pools) {
    addrs.add(getAddress(p.token0));
    addrs.add(getAddress(p.token1));
  }
  const map = new Map<string, ResolvedToken>();
  await Promise.all(
    [...addrs].map(async (address) => {
      try {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({ address: address as Hex, abi: erc20Abi, functionName: "symbol" }),
          publicClient.readContract({ address: address as Hex, abi: erc20Abi, functionName: "decimals" }),
        ]);
        map.set(symbol as string, { address: address as Hex, decimals: Number(decimals) });
      } catch (err) {
        log.warn({ err, address }, "could not read token metadata, skipping");
      }
    }),
  );
  tokenCache = map;
  return map;
}

// Resolve a token symbol to address and decimals. Verified core tokens come from
// addresses.ts; Mento local-currency stablecoins resolve at runtime from pools.
export async function resolveMentoToken(symbol: string, mento: Mento): Promise<ResolvedToken> {
  const core = (TOKENS as Record<string, ResolvedToken>)[symbol];
  if (core) return core;
  const map = await buildMentoTokenMap(mento);
  const onchainSymbol = MENTO_SYMBOL_ALIASES[symbol] ?? symbol;
  const found = map.get(onchainSymbol);
  if (!found) {
    throw new Error(
      `unknown token symbol ${symbol} (tried ${onchainSymbol}; not in addresses.ts or Mento pools)`,
    );
  }
  return found;
}
