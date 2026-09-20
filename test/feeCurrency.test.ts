// Guard the fee-currency mapping used by every send.
//
// This is the failure that does not announce itself. Passing a 6-decimal token
// address as feeCurrency looks correct in review and typechecks fine, but the
// node cannot price gas against it and rejects the transaction. It cost us a
// fleet outage once already. These tests pin the rule so a future edit that
// "simplifies" the adapters back into token addresses fails here instead of in
// someone's wallet.
import { describe, it, expect } from "vitest";
import { TOKENS, FEE_ADAPTERS } from "../shared/addresses.js";

describe("fee currency mapping", () => {
  it("uses a dedicated adapter for every 6-decimal token", () => {
    for (const sym of ["USDC", "USDT"] as const) {
      expect(TOKENS[sym].decimals).toBe(6);
      expect(FEE_ADAPTERS[sym].toLowerCase()).not.toBe(TOKENS[sym].address.toLowerCase());
    }
  });

  it("uses the token address itself for 18-decimal cUSD", () => {
    expect(TOKENS.cUSD.decimals).toBe(18);
    expect(FEE_ADAPTERS.cUSD.toLowerCase()).toBe(TOKENS.cUSD.address.toLowerCase());
  });

  it("gives every adapter a distinct, well-formed address", () => {
    const seen = new Set<string>();
    for (const [sym, adapter] of Object.entries(FEE_ADAPTERS)) {
      expect(adapter, `${sym} adapter shape`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const key = adapter.toLowerCase();
      expect(seen.has(key), `${sym} adapter is a duplicate`).toBe(false);
      seen.add(key);
    }
  });

  it("covers every token the direct-send UI offers", () => {
    // Kept in step with SEND_TOKENS in app/app/page.tsx. A token offered there
    // without an adapter here is a send that cannot pay for its own gas.
    for (const sym of ["cUSD", "USDT", "USDC"] as const) {
      expect(TOKENS[sym], `${sym} missing from TOKENS`).toBeDefined();
      expect(FEE_ADAPTERS[sym], `${sym} missing from FEE_ADAPTERS`).toBeDefined();
    }
  });
});
