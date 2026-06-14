---
name: mento-fx
description: Use to swap between local-currency stablecoins on Celo through Mento. Quotes the swap, applies slippage protection with amountOutMin, fetches exchange IDs at runtime, pays gas in stablecoin, and logs the result. Used for DCA buys and FX rebalancing.
---

# mento-fx

## Purpose

Performs onchain FX between Mento stablecoins (for example cUSD to cKES, cNGN, cGHS, cZAR, cEUR). This powers two schedule kinds: `dca` (swap a fixed stablecoin amount into a target asset on a cadence) and `fx_rebalance` (move basket weights back toward target). Onchain FX is a named Celo use case and a core source of the agent genuine, diverse transaction volume.

## When to use

- When `remitroute-core` dispatches a due `dca` schedule: swap the fixed amount into the target asset.
- When `remitroute-core` dispatches a due `fx_rebalance` schedule, or when Guardian 3 detects a leg has drifted past its hard band: swap only the drifting legs back toward target.

## Scripts

- `scripts/swap.ts --user <id> --tokenIn <symbol> --tokenOut <symbol> --amountIn <human-amount> --slippageBps <bps>`: quotes the swap, computes `amountOutMin`, approves the input token to the broker if needed, executes the swap, pays gas in stablecoin via the `fee-abstraction` helper, waits for the receipt, and writes an `executions` row.

## How the swap works

1. Create a Mento client bound to the wallet. Confirm the current `@mento-protocol/mento-sdk` method surface before wiring; the API has evolved.
2. Quote the output for `amountIn` (for example via `getAmountOut`).
3. Compute `amountOutMin = quote * (1 - slippageBps / 10000)`. Default slippage is a tight band (for example 50 bps); cap it at a configured maximum.
4. Fetch the exchange and provider IDs at runtime from the SDK. Do not hardcode exchange IDs; they are dynamic.
5. Approve the input token to the broker if the allowance is insufficient.
6. Execute the swap (for example `swapIn`) with `amountOutMin` and `feeCurrency` set.
7. Wait for the receipt and write the result.

## Inputs

- `user`: resolves the funding sub-wallet.
- `tokenIn`, `tokenOut`: symbols resolved to verified addresses in `shared/addresses.ts`.
- `amountIn`: human-readable, parsed to decimals.
- `slippageBps`: basis points of allowed slippage, bounded by the configured maximum.

## Guardrails

- Always set `amountOutMin`. Never swap with zero slippage protection.
- Bound slippage at the configured maximum. Reject a swap that would exceed it.
- Enforce per-user and global daily spend caps before swapping.
- Resolve token addresses from `shared/addresses.ts` only. Verify cKES, cNGN, cGHS, cZAR, cEUR and the Mento Broker on Celoscan or Celopedia before mainnet use.
- Set `feeCurrency`. Respect the per-schedule lock.

## Outputs

An `executions` row with `amount_in`, `token_in`, `amount_out`, `token_out`, `tx_hash`, `status`, and `fee_currency`.

## Logging

Log the quote, the `amountOutMin`, the realized output, the transaction hash, and the slippage actually incurred. Watch for repeated reverts on a route, which Guardian 9 treats as an anomaly.
