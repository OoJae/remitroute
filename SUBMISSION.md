# RemitRoute - Agents at Work submission

**Primary track:** Value Moved. Also entered: Real World Adoption, AskBots Growth,
Judges' Favorite.

**Attribution tag:** `celo_716fa1c99481` · **Network:** Celo mainnet (42220)

**Wallets we control:** all 26 are enumerated in [WALLETS.md](WALLETS.md).

> **On value moved in the judging window, and how we measure it.** Two different things
> move money under our tag, they are counted in two different places, and we are only in
> a position to count one of them.
>
> **Server-executed actions, from the wallets we control: zero.** The heartbeat engine
> ran continuously from 28 August to 20 September and attempted 166 scheduled actions.
> Every one returned `skipped_low_balance` or `skipped_dust`, and not one carries a
> transaction hash, because the custodial wallets are empty. That figure is a query over
> our `executions` table, which records every action our own keys signed, and for those
> wallets it is the complete picture.
>
> **User-signed transfers, from wallets we do not control: measured on-chain, not by us.**
> The Mini App also lets a person pay someone, or fund their automation wallet, straight
> from their own MiniPay wallet. We are not in that path: the user signs, their wallet
> broadcasts, we never hold the money and we write nothing to our database. Those
> transactions do carry our ERC-8021 tag `celo_716fa1c99481`, so they are visible and
> countable on-chain by anyone reading the tag. We quote no figure for them, because we
> do not hold the ledger that would let us. The authoritative number is whatever the
> leaderboard reads from the chain.
>
> We are entered in this track on the strength of the rails being real, tagged and
> auditable. Whatever the tagged total turns out to be, small or large, it is the chain's
> number and not ours.

**One-liner:** Set one rule. Your money runs itself. An always-on agent on Celo that
runs your savings, FX, and remittances automatically, with gas paid in stablecoins.

## Links

- **Live app (MiniPay Mini App):** `https://remitroute.vercel.app/app`
- **Landing:** `https://remitroute.vercel.app`
- **Public live dashboard:** `https://remitroute.vercel.app/dashboard`
- **ERC-8004 agent #9308 (agentscan):** `https://agentscan.info/agents/9308`
- **Machine-readable registration:** `https://remitroute.vercel.app/.well-known/agent.json`
- **x402 paid FX-route API:** `https://remitroute.vercel.app/api/fx-route`
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

Six money actions, all live on mainnet:

1. **Savings sweep** - "Save 10 percent every Friday" moves idle cUSD into Aave V3 yield.
2. **FX rebalance** - "Keep 40 percent in cKES, rebalance weekly" swaps on Mento with slippage protection.
3. **Remittance** - "Send 5,000 NGNm on the 1st" schedules local-currency transfers.
4. **DCA** - "Stack 2 dollars of CELO daily" dollar-cost-averages a buy.
5. **Withdrawal** - one tap returns funds to the user's own MiniPay wallet.
6. **Direct send** - pay someone straight from your own MiniPay wallet, picked by phone
   number through SocialConnect or by address. Non-custodial: the user signs, their
   wallet broadcasts, we are never in the path. Gas is still paid in the token being
   sent, so the sender never needs CELO.

## How it works

1. **Connect in MiniPay.** One tap, auto-connect, no seed phrase.
2. **Set a rule in plain language.** The agent parses it into a typed, capped schedule
   and reads it back before anything moves.
3. **The agent runs it onchain.** A deterministic heartbeat wakes every ~20 minutes and
   runs a 6-guard loop: health check, load due rules, execute, post metrics, confirm,
   safety and halt. Every action is stamped with a validation proof hash on the public
   live dashboard.

There are two paths, and they differ in custody. For **scheduled** actions, funds sit in a
per-user custodial execution wallet (keys AES-256-GCM encrypted at rest) so the agent can
run a rule on its heartbeat without asking the user to sign each time; those funds can be
withdrawn to the user's own wallet at any moment. For a **direct send** there is no custody
at all: the money goes wallet to wallet, the user signs it in MiniPay, and we never hold it.

## Why it is safe (it moves real money)

- **Spend caps** per transaction, per user per day, and global per day (enforced in code; see the note below on how they are currently configured).
- **Circuit breaker** that halts the engine on a failure or volume anomaly.
- **Gas floor** that stops money movement when the stablecoin gas buffer runs low.
- **Idempotency** at the database level, so a schedule can never double-execute.
- **Proof hash** per action, a deterministic keccak256 digest anyone can recompute, shown on the dashboard.

It is live on Celo mainnet right now, with real transactions across every action type in
its history. The cap machinery in `shared/caps.ts` is still wired into every money path,
but the operator-configured limits were raised during a previous hackathon and were never
lowered again, so treat the circuit breaker and the gas floor, not the caps, as the
binding safety controls today.

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
Identity + Reputation registries, x402 (settled through the Celo facilitator, with a
self-hosted EIP-3009 facilitator as the fallback path), an OpenClaw heartbeat
agent, Neon Postgres (drizzle-orm), Next.js 15 (App Router), TypeScript. The web app is
deployed serverless; the heartbeat engine runs as a deterministic systemd timer.

## 60-second demo

1. Open `https://remitroute.vercel.app/app` in MiniPay. It auto-connects, no signing.
2. Tap **Send money now**, pick a recipient by phone number or paste an address, and pay
   them straight from your own wallet: gas in the token you send, no CELO, no custody.
   (For the automated path instead, fund the automation wallet with a little cUSD.)
3. Type a rule: "Save 10 percent every Friday." The agent reads it back, you confirm.
4. Open `https://remitroute.vercel.app/dashboard` to watch the live feed: actions by city, the circuit-breaker
   status, and a proof hash per action.
5. The agent keeps running it onchain on its heartbeat, gas in cUSD, forever.

## Tweet (for the submission)

Primary:

> RemitRoute is live on @Celo. Set one rule in MiniPay (save 10% every Friday, send
> NGNm on the 1st, keep 40% in cKES) and an onchain agent runs it forever, gas paid in
> stablecoins. ERC-8004 agent #9308. Built for Lagos, Nairobi, Joburg. https://remitroute.vercel.app
> @CeloDevs

Alternate:

> Your money should move on its own. RemitRoute is an always-on agent on @Celo doing
> recurring savings, FX, and remittances for everyday users, custodial automation wallet with withdraw-anytime, gas in
> cUSD, every action proof-stamped onchain. ERC-8004 #9308. https://remitroute.vercel.app @CeloDevs
