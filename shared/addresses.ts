// Single source of truth for every contract address. Never hardcode an address
// elsewhere. Each entry notes its source and the date it was checked.
//
// Verification policy:
// - Addresses marked VERIFIED are taken from the hackathon docs or the official
//   Celo token-addresses page and confirmed on Celoscan.
// - Mento per-currency stablecoins and the Mento exchange/provider IDs are
//   resolved at runtime via the Mento SDK, not hardcoded (the IDs are dynamic).
// - The Aave V3 Pool is resolved at runtime via its PoolAddressesProvider.
//
// checked 2026-06-11

export type Hex = `0x${string}`;

export const CELO_CHAIN_ID = 42220;

// Core tokens. VERIFIED.
export const TOKENS = {
  // cUSD, 18 decimals. Source: docs.celo.org token-addresses, Celoscan.
  cUSD: {
    address: "0x765DE816845861e75A25fCA122bb6898B8B1282a" as Hex,
    decimals: 18,
  },
  // cEUR (Mento EURm), 18 decimals. Source: Mento pools + aave-address-book, Celoscan.
  cEUR: {
    address: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73" as Hex,
    decimals: 18,
  },
  // CELO native asset token, 18 decimals. Source: Celoscan.
  CELO: {
    address: "0x471EcE3750Da237f93B8E339c536989b8978a438" as Hex,
    decimals: 18,
  },
  // USDC, 6 decimals. Source: hackathon docs, Celoscan.
  USDC: {
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Hex,
    decimals: 6,
  },
  // USDT, 6 decimals. Source: hackathon docs, Celoscan.
  USDT: {
    address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Hex,
    decimals: 6,
  },
} as const satisfies Record<string, { address: Hex; decimals: number }>;

export type TokenSymbol = keyof typeof TOKENS;

// Fee-abstraction adapters. When paying gas in USDC or USDT, feeCurrency must be
// the ADAPTER, not the token (adapters normalize 6-decimal tokens to 18-decimal
// gas pricing). For cUSD the token address is used directly as the fee currency.
// VERIFIED. Source: hackathon docs.
export const FEE_ADAPTERS = {
  // cUSD is an 18-decimal Mento stable; its token address doubles as the fee
  // currency. Confirmed against the fee-abstraction skill manifest.
  cUSD: TOKENS.cUSD.address,
  USDC: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B" as Hex,
  USDT: "0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72" as Hex,
} as const;

// Mento Broker (mainnet). VERIFIED. Source: hackathon strategy doc, Celoscan.
// Exchange and provider IDs are fetched at runtime via the Mento SDK.
export const MENTO_BROKER = "0x777B8E2F5F356c5c284342aFbF009D6552450d69" as Hex;

// ERC-8004 registries (mainnet). VERIFIED. Source: hackathon docs.
export const ERC8004 = {
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Hex,
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Hex,
} as const;

// Aave V3 on Celo. VERIFIED. Source: bgd-labs/aave-address-book, checked 2026-06-11.
// The Pool itself is resolved at runtime from the provider's getPool() (the proxy
// can be upgraded); the address-book Pool value 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402
// is the cross-check.
export const AAVE = {
  poolAddressesProvider: "0x9F7Cf9417D5251C59fE94fB9147feEe1aAd9Cea5" as Hex,
} as const;

// Assets RemitRoute will supply to Aave V3 on Celo. All are confirmed reserves.
export const AAVE_APPROVED_ASSETS = new Set<string>(["cUSD", "USDC", "USDT", "cEUR", "CELO"]);

// Resolved at runtime, not hardcoded.
// - Mento stablecoins (cKES, cNGN, cGHS, cZAR, cEUR): resolved at runtime from the
//   live Mento pools in mento-fx/swap.ts (symbols rebranded to an m-suffix on-chain).
export const RUNTIME_RESOLVED = {
  aaveV3Pool: null as Hex | null,
  mentoStables: {} as Record<string, Hex>,
} as const;

// Resolve a token symbol to its verified address and decimals. Throws on an
// unknown symbol so a parsing error can never produce a raw address.
export function resolveToken(symbol: string): { address: Hex; decimals: number } {
  const entry = (TOKENS as Record<string, { address: Hex; decimals: number }>)[symbol];
  if (!entry) {
    throw new Error(`Unknown or unverified token symbol: ${symbol}`);
  }
  return entry;
}

// Resolve the fee-currency adapter for the configured fee currency.
export function resolveFeeAdapter(symbol: "cUSD" | "USDC" | "USDT"): Hex {
  return FEE_ADAPTERS[symbol];
}
