---
name: erc8004
description: Use to register RemitRoute on the ERC-8004 Identity Registry, to help real users submit feedback to the Reputation Registry, and to post operational metric tags each cycle. Drives the agent presence and rank on 8004scan.
---

# erc8004

## Purpose

Manages RemitRoute trust footprint on ERC-8004, which is what the agent appears on in 8004scan. Three jobs: register the agent once, enable real users to leave feedback, and post operational metric tags each cycle. Strong, genuine reputation here is the path to the Track 3 leaderboard prize.

## When to use

- Once, early in the build (Phase 6): call `register.ts` to mint the agent identity so it shows on 8004scan and starts accruing time-based signals.
- After a user has been served (an executed action they can see): prompt them to leave feedback, recorded through `feedback.ts`.
- Every heartbeat (Guardian 7): call `post-metrics.ts` to post `uptime`, `successRate`, and `responseTime` from the monitoring address.

## Scripts

- `scripts/register.ts`: uploads the agent registration JSON (see `registration/remitroute-agent.json`) to IPFS or a public URL, then calls the Identity Registry `register(agentURI)` to mint the agent identity NFT, paying gas in stablecoin. Records the returned `agentId`. Run once.
- `scripts/feedback.ts --agentId <id> --client <address> --score <0-100> --tag <tag> --txProof <hash>`: helps a real user wallet submit feedback to the Reputation Registry, attaching an x402 payment proof or a served-action transaction hash where available, and logs it to `feedback_log`. The user wallet signs the feedback; the agent does not rate itself.
- `scripts/post-metrics.ts`: posts this cycle metric tags from the monitoring address.

## Verified addresses (mainnet)

- Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Critical reputation rule

The Reputation Registry blocks the agent owner and operator addresses from rating their own agent. Reputation must come from other wallets, which is exactly where the real community of distinct users matters. Feedback from many unique, reputable wallets, ideally with x402 payment proofs attached, is what moves the score. Do not attempt to self-rate from owner or operator addresses; it will be rejected and reads as gaming under manual judge review.

## Inputs

- The registration JSON for `register.ts` (name, description, image, endpoints, supportedTrust).
- For `feedback.ts`: the rating user wallet, a score, a tag, and a proof.

## Guardrails

- Confirm the current `@chaoschain/sdk` method surface before wiring; adjust to the live API.
- Keep feedback genuine. Solicit it only from real users who were actually served. Diverse, real, distinct-wallet feedback survives manual review; clustered or synthetic feedback does not.
- Set `feeCurrency` on all writes.

## Outputs

- `register.ts`: the agent `agentId`, saved to config and the dashboard.
- `feedback.ts`: a `feedback_log` row and the onchain feedback transaction.
- `post-metrics.ts`: the metric-tag transactions for the cycle.

## Logging

Log the `agentId` on registration, every feedback transaction with the client address and score, and the metric tags posted each cycle. Keep `successRate` high by fixing failing patterns quickly.
