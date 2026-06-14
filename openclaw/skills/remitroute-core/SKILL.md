---
name: remitroute-core
description: The orchestrator. Use to parse a user natural-language rule into a structured schedule, and to run all due schedules each heartbeat by dispatching to the transfer, mento-fx, and yield skills under spend caps and a per-schedule lock.
---

# remitroute-core

## Purpose

The brain of RemitRoute. Two jobs: turn a user plain-language rule into a structured schedule row, and on each heartbeat run every due schedule by dispatching to the right money-movement skill under strict caps and idempotency. All scheduling state lives in Postgres. All money movement runs through typed skill scripts, never raw model output.

## When to use

- During onboarding, when a user states a rule in the Mini App or Telegram (for example "save 10 percent every Friday"): call `parse-rule.ts` to produce a validated schedule row.
- Every heartbeat (Guardian 2): call `run-due.ts` to execute all due schedules.

## Scripts

- `scripts/parse-rule.ts --user <id> --text "<rule>"`: parses the rule into a structured schedule. Validates with zod. Resolves the kind (`dca`, `savings_sweep`, `fx_rebalance`, `remittance`, `bill_drip`), the params (amounts, target asset, recipient, percentages, target weights), the cadence, and the first `next_run`. For remittances, resolves and confirms the recipient against the user allowlist (and optionally via ODIS phone lookup, see the MiniPay integration). Returns the row for user confirmation before it is saved as active.
- `scripts/run-due.ts`: loads all active schedules where `next_run <= now()`, ordered by `next_run`, and for each one enforces caps, acquires the per-schedule lock, dispatches by kind, writes the execution, recomputes and persists `next_run`, and releases the lock. Continues past individual failures.
- `scripts/reschedule.ts --schedule <id>`: recomputes `next_run` from the cadence. Used by `run-due.ts` and after manual edits.

## Dispatch table

- `dca`: call `mento-fx/scripts/swap.ts` to swap the fixed amount into the target asset.
- `savings_sweep`: compute the sweep amount as a percentage of the user idle balance, then call `yield/scripts/supply.ts`.
- `fx_rebalance`: read current basket weights, compare to target weights in params, and call `mento-fx` only for the legs past the drift threshold.
- `remittance`: call `transfer/scripts/send.ts` to the recipient.
- `bill_drip`: call `transfer/scripts/send.ts` to the biller or merchant.

## Guardrails

- Enforce per-user and global daily spend caps before dispatching any action. Skip and log if a cap would be breached.
- Idempotency: acquire the per-schedule lock before executing and release after. Never execute the same schedule twice in one cycle.
- Determinism: the dispatch and the money movement are typed code. The model decides which schedule is due and which kind it is, then calls the script. The model never emits transaction parameters directly.
- Validate every parsed rule with zod. Never save a rule that fails validation. Always confirm a parsed rule with the user before it goes active.
- If funds for an action are sitting in yield, withdraw the needed amount via the `yield` skill first, then execute.

## Outputs

- `parse-rule.ts`: a validated `schedules` row (pending user confirmation).
- `run-due.ts`: one `executions` row per dispatched action, plus updated `next_run` values.

## Logging

Log each cycle: schedules loaded, dispatched, succeeded, failed, and total volume moved. This feeds the cycle summary in Guardian 9 and the dashboard aggregates.
