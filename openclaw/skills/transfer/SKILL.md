---
name: transfer
description: Use to send a stablecoin transfer onchain for a scheduled remittance or bill drip. Handles the recipient, amount, and token, pays gas in stablecoin, and writes the result to the executions ledger.
---

# transfer

## Purpose

Executes scheduled stablecoin transfers: remittances (for example sending cNGN to a family member) and bill drips (paying a biller or merchant on a schedule). This is the simplest money-movement skill and is the fastest path to a real onchain transaction during the build.

## When to use

- When `remitroute-core` dispatches a due schedule of kind `remittance` or `bill_drip`.
- For the first mainnet smoke test in Phase 1 of the build, sending a tiny transfer to confirm the fee-abstraction path works end to end.

## Scripts

- `scripts/send.ts --user <id> --to <address> --amount <human-amount> --token <symbol>`: sends the transfer from the user sub-wallet (or the treasury for the smoke test), pays gas in stablecoin via the `fee-abstraction` helper, waits for the receipt, and writes an `executions` row with the transaction hash and status.

## Inputs

- `user`: the user id, used to resolve the funding sub-wallet and its encrypted key reference.
- `to`: the recipient address. Must pass validation and the per-user recipient allowlist.
- `amount`: the human-readable amount. Parsed to token decimals.
- `token`: the token symbol, resolved to its verified address in `shared/addresses.ts`.

## Guardrails

- Enforce the per-user and global daily spend caps before sending. Skip and log if a cap would be breached.
- Validate the recipient address. For remittances, check it against the user recipient allowlist set during onboarding, so a parsing error cannot send funds to the wrong place.
- Resolve the token address from `shared/addresses.ts` only. Never accept a raw address from model output.
- Set `feeCurrency` on the transaction. Never send without it.
- Respect the per-schedule lock so a transfer cannot fire twice in one cycle.

## Outputs

An `executions` row: `kind`, `tx_hash`, `status`, `amount_in`, `token_in`, `fee_currency`, and `error` if any.

## Logging

Log the user, recipient, amount, token, transaction hash, and status. On failure, log the revert reason and let `remitroute-core` decide on a single retry.
