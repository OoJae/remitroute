// Fee-abstraction helper. Every onchain send routes through this so gas is paid
// in a stablecoin and no native CELO balance is ever required.
// Rule from the fee-abstraction skill: never send a transaction without feeCurrency.
import { config } from "./config.js";
import { resolveFeeAdapter, type Hex } from "./addresses.js";

// The fee-currency adapter the agent treasury pays gas with, from config.
export function feeCurrencyAdapter(): Hex {
  return resolveFeeAdapter(config.FEE_CURRENCY);
}

// Inject feeCurrency into any viem writeContract or sendTransaction request.
// Other skills call this rather than setting feeCurrency by hand.
export function withFeeCurrency<T extends Record<string, unknown>>(
  tx: T,
): T & { feeCurrency: Hex } {
  return { ...tx, feeCurrency: feeCurrencyAdapter() };
}
