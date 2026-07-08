import { describe, it, expect } from "vitest";
import { isUsdStable } from "../shared/usdStable.js";

describe("isUsdStable", () => {
  it("treats the USD stablecoins as 1:1 (no quote needed)", () => {
    for (const s of ["cUSD", "USDC", "USDT"]) expect(isUsdStable(s)).toBe(true);
  });
  it("treats non-USD legs as needing a Mento quote", () => {
    // These are worth more (cEUR/CELO) or far less (cKES/cNGN) than $1, which is
    // exactly why the cap must value them rather than count nominal units.
    for (const s of ["cEUR", "cKES", "cNGN", "CELO", "cGHS"]) expect(isUsdStable(s)).toBe(false);
  });
  it("is exact-match and case-sensitive (an unknown symbol is not assumed 1:1)", () => {
    for (const s of ["cusd", "USD", "", "cUSDC"]) expect(isUsdStable(s)).toBe(false);
  });
});
