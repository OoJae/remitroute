# RemitRoute - Celo Onchain Agents Hackathon submission

**Track:** Real-world payments / everyday applications

**One-liner:** Set one rule. Your money runs itself. An always-on agent on Celo that
runs your savings, FX, and remittances automatically, with gas paid in stablecoins.

## Links

- **Live app (MiniPay Mini App):** `<LIVE_URL>/app`
- **Landing:** `<LIVE_URL>`
- **Public live dashboard:** `<LIVE_URL>/dashboard`
- **ERC-8004 agent #9308 (agentscan):** `<AGENTSCAN_URL>`
- **Machine-readable registration:** `<LIVE_URL>/.well-known/agent.json`
- **x402 paid FX-route API:** `<LIVE_URL>/api/fx-route`
- **Code (GitHub):** https://github.com/OoJae/remitroute

## The problem

For everyday people in Lagos, Nairobi, and Johannesburg, the routine parts of money
are a chore. Remittances are repetitive. Savings sit idle and earn nothing. Holding
the right currency mix takes constant attention. People do not have time to manage
their money every day, and the apps that exist assume they will.

## What RemitRoute does

RemitRoute is an autonomous agent on Celo that handles the recurring parts of personal
finance, so the routine just happens. The user sets one rule, in plain language, inside
the MiniPay Mini App. After that, an OpenClaw agent runs it onchain forever on a
heartbeat. No dashboards to babysit, no transactions to sign for recurring actions, gas
paid in a stablecoin via Celo fee abstraction so the user never needs to hold CELO.

Five money actions, all live on mainnet:

1. **Savings sweep** - "Save 10 percent every Friday" moves idle cUSD into Aave V3 yield.
2. **FX rebalance** - "Keep 40 percent in cKES, rebalance weekly" swaps on Mento with slippage protection.
3. **Remittance** - "Send 5,000 cNGN on the 1st" schedules local-currency transfers.
4. **DCA** - "Stack 2 dollars of CELO daily" dollar-cost-averages a buy.
5. **Withdrawal** - one tap returns funds to the user's own MiniPay wallet.

## How it works

1. **Connect in MiniPay.** One tap, auto-connect, no seed phrase.
2. **Set a rule in plain language.** The agent parses it into a typed, capped schedule
   and reads it back before anything moves.
3. **The agent runs it onchain.** A deterministic heartbeat wakes every ~20 minutes and
   runs a 6-guard loop: health check, load due rules, execute, post metrics, confirm,
   safety and halt. Every action is stamped with a validation proof hash on the public
   live dashboard.

Funds stay in the user's own execution wallet (non-custodial) and can be withdrawn anytime.

## Why it is safe (it moves real money)

- **Spend caps** per transaction, per user per day, and global per day.
- **Circuit breaker** that halts the engine on a failure or volume anomaly.
- **Gas floor** that stops money movement when the stablecoin gas buffer runs low.
- **Idempotency** at the database level, so a schedule can never double-execute.
- **Proof hash** per action, a deterministic keccak256 digest anyone can recompute, shown on the dashboard.

It is live on Celo mainnet right now, bounded by tiny caps and the circuit breaker, with
real transactions across every action type.

## Onchain identity and reputation

Registered on ERC-8004 as agent **#9308** on Celo mainnet (Identity + Reputation
registries). Users can leave onchain feedback from their own wallet after the agent
serves them. Verifiable on agentscan.

## Agent economy (x402)

RemitRoute is not just a consumer app, it is also infrastructure for other agents. It
exposes a paid FX-route API at `GET /api/fx-route` that returns a live cUSD-to-local
route and rate. Other agents pay per call, settled onchain on Celo via x402 (the endpoint
returns HTTP 402 with payment requirements until paid).

## Tech stack

Celo mainnet (chainId 42220), MiniPay, viem, Mento SDK (FX), Aave V3 (yield), ERC-8004
Identity + Reputation registries, x402 (thirdweb facilitator), an OpenClaw heartbeat
agent, Neon Postgres (drizzle-orm), Next.js 15 (App Router), TypeScript. The web app is
deployed serverless; the heartbeat engine runs as a deterministic systemd timer.

## 60-second demo

1. Open `<LIVE_URL>/app` in MiniPay. It auto-connects, no signing.
2. Fund the automation wallet with a little cUSD.
3. Type a rule: "Save 10 percent every Friday." The agent reads it back, you confirm.
4. Open `<LIVE_URL>/dashboard` to watch the live feed: actions by city, the circuit-breaker
   status, and a proof hash per action.
5. The agent keeps running it onchain on its heartbeat, gas in cUSD, forever.

## Tweet (for the submission)

Primary:

> RemitRoute is live on @Celo. Set one rule in MiniPay (save 10% every Friday, send
> cNGN on the 1st, keep 40% in cKES) and an onchain agent runs it forever, gas paid in
> stablecoins. ERC-8004 agent #9308. Built for Lagos, Nairobi, Joburg. <LIVE_URL>
> @CeloDevs

Alternate:

> Your money should move on its own. RemitRoute is an always-on agent on @Celo doing
> recurring savings, FX, and remittances for everyday users, non-custodial, gas in
> cUSD, every action proof-stamped onchain. ERC-8004 #9308. <LIVE_URL> @CeloDevs
