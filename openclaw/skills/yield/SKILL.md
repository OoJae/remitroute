---
name: yield
description: Use to move idle stablecoins into and out of yield on Aave V3 for savings sweeps. Supplies on a sweep schedule and withdraws on request, pays gas in stablecoin, and logs the result.
---

# yield

## Purpose

Puts a user idle stablecoins to work by supplying them to Aave V3 on Celo, and withdraws when the user wants funds back. This powers the `savings_sweep` schedule kind. Each supply and each withdraw is a discrete onchain transaction.

## When to use

- When `remitroute-core` dispatches a due `savings_sweep`: supply the computed sweep amount.
- When a user requests a withdrawal from the Mini App or Telegram, or when a downstream action (a remittance) needs funds that are currently in yield: withdraw the needed amount first.

## Scripts

- `scripts/supply.ts --user <id> --asset <symbol> --amount <human-amount>`: approves the asset to the Aave Pool if needed, calls `supply`, pays gas in stablecoin via the `fee-abstraction` helper, waits for the receipt, and writes an `executions` row.
- `scripts/withdraw.ts --user <id> --asset <symbol> --amount <human-amount>`: calls `withdraw` to the user sub-wallet, pays gas in stablecoin, waits for the receipt, and writes an `executions` row.

## How it works

1. Resolve the Aave V3 Pool address from `shared/addresses.ts`. Verify it on Celopedia or the Aave address book before mainnet use.
2. Supply: `approve(asset, pool, amount)` if allowance is short, then `Pool.supply(asset, amount, onBehalfOf, referralCode)`.
3. Withdraw: `Pool.withdraw(asset, amount, to)`.
4. Set `feeCurrency` on both transactions.

## Inputs

- `user`: resolves the funding sub-wallet.
- `asset`: token symbol resolved to a verified address. Only approved assets are allowed.
- `amount`: human-readable, parsed to decimals. For a sweep, `remitroute-core` computes the amount as a percentage of the user idle balance.

## Guardrails

- Enforce per-user and global daily spend caps before supplying.
- Only supply approved assets. Reject anything not on the approved list in config.
- Resolve the Pool address and asset addresses from `shared/addresses.ts` only.
- Set `feeCurrency`. Respect the per-schedule lock.
- Keep a minimum liquid balance in the sub-wallet so the agent can still pay gas and run due transfers; do not sweep everything.

## Outputs

An `executions` row with `kind`, `amount_in`, `token_in`, `tx_hash`, `status`, and `fee_currency`.

## Logging

Log the asset, amount, transaction hash, and status for both supply and withdraw. Confirm the Aave Pool ABI and the function signatures against the current Aave V3 deployment before wiring.
