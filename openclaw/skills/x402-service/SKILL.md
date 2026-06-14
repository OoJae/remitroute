---
name: x402-service
description: Use to run and monitor the paid FX-route API that other agents pay per call via x402. Each paid call is an onchain settlement and a financial-activity signal. The agent ensures the endpoint is healthy and logs the payments.
---

# x402-service

## Purpose

Exposes a paid endpoint that other agents call to get an optimal Mento FX route and live rate, paying per call through x402 on Celo. This adds agent-to-agent transaction volume and a financial-activity signal that the 8004scan score rewards, on top of the user-driven transactions. The endpoint itself is a Next.js route in the app; this skill is how the agent reasons about, monitors, and accounts for it.

## When to use

- During the build (Phase 8): stand up the paid endpoint and verify a second wallet or agent can pay it and the payment settles on Celo.
- Each heartbeat, lightly: confirm the endpoint is reachable and reconcile new x402 payments into the ledger so they show in activity and can back ERC-8004 feedback.

## The endpoint

- Route: `GET /api/fx-route` in the Next.js app.
- Behavior: uses thirdweb `settlePayment` with the Celo network and the agent server wallet as `payTo`. On a settled payment it returns the optimal route and rate; otherwise it returns the x402 payment-required response so the caller can pay and retry.
- Price: a small per-call price (for example 0.01 dollars), set in config.

## Scripts

- `scripts/health.ts`: pings the endpoint and confirms it responds and can settle. Reports pass or fail.
- `scripts/reconcile.ts`: reads recent settled x402 payments and writes them to `treasury_actions` (or a payments table) so they appear in activity and can be referenced as proofs in `erc8004` feedback.

## Inputs

- thirdweb client id and secret, the agent server wallet address, and the price, all from config.

## Guardrails

- The endpoint must verify payment before returning the paid data. Never return the paid result without a settled payment.
- Set the network to Celo and the `payTo` to the agent server wallet.
- Do not expose any user data through this endpoint. It returns only public FX route and rate information.

## Outputs

- A settled x402 payment per paid call, plus the returned route and rate.
- `treasury_actions` or payment rows from `reconcile.ts`.

## Logging

Log each paid call: the payer, the amount, and the settlement transaction. These payments are genuine financial activity; surface them on the dashboard and reference them as proofs where useful. Confirm the current thirdweb x402 API surface before wiring.
