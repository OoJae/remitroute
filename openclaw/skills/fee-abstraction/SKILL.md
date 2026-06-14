---
name: fee-abstraction
description: Use on every onchain transaction to pay gas in a stablecoin (cUSD or USDC) through Celo fee abstraction, so the agent never needs a native CELO balance. Also used to check the gas buffer floor before any money movement.
---

# fee-abstraction

## Purpose

Celo lets a transaction pay its gas in a stablecoin by setting the `feeCurrency` field. This skill is the shared wrapper that every other skill uses so all RemitRoute transactions pay gas in cUSD or USDC, and the agent treasury stays a single stablecoin. It also guards the gas buffer floor so the agent never strands itself without gas.

## When to use

- On every transaction the agent sends. No exceptions. The transfer, mento-fx, yield, and erc8004 skills all route their sends through this wrapper.
- At the start of each heartbeat (Guardian 1) to confirm the treasury fee-currency balance is above the floor.

## Key rule: adapter, not token

When paying gas in USDC or USDT, set `feeCurrency` to the adapter address, not the token address. Adapters normalize the 6-decimal tokens to the 18-decimal format Celo gas pricing requires. For 18-decimal tokens like cUSD, confirm whether the token address or an adapter is required, and record the answer in `shared/addresses.ts`.

Verified adapter addresses (mainnet):

- USDC adapter: `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B`
- USDT adapter: `0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72`

## Scripts and helpers

- `shared/feeCurrency.ts` (helper): exposes the fee currency constant and a helper that injects `feeCurrency` into any viem `writeContract` or `sendTransaction` call. Other skills import this rather than setting `feeCurrency` by hand.
- `scripts/check-gas-buffer.ts`: reads the treasury balance of the chosen fee-currency token and returns whether it is above the configured floor. Returns a clear pass or fail plus the current balance. Guardian 1 stops the cycle on a fail.

## Inputs

- The fee-currency token and adapter to use (from config and `shared/addresses.ts`).
- The gas floor amount (from config).

## Guardrails

- Never send a transaction without `feeCurrency` set.
- Never move money when `check-gas-buffer.ts` reports below the floor. Alert the operator instead.
- Keep a sensible buffer so a burst of due actions in one cycle cannot drain gas mid-batch.

## Logging

Log the fee currency used and the gas balance at the start of each cycle. On a buffer failure, log the shortfall and alert.

## Notes

The exact `feeCurrency` field support is provided natively by viem on the Celo chain. Confirm the viem version and that the Celo chain object is imported from `viem/chains`.
