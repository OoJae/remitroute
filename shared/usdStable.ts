// Pure, dependency-free classification of which token symbols are USD stablecoins
// (valued 1:1 with USD for spend-cap accounting). Kept in its own module, apart
// from usdValue.ts, so it can be unit-tested without importing the Mento SDK.
const USD_STABLES = new Set(["cUSD", "USDC", "USDT"]);

export function isUsdStable(symbol: string): boolean {
  return USD_STABLES.has(symbol);
}
