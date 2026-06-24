# RemitRoute

**Set one rule. Your money runs itself.**

RemitRoute is an always-on agent on Celo for recurring stablecoin personal finance,
with a [MiniPay](https://www.opera.com/products/minipay) Mini App as the front door.
A user sets a simple rule once in plain language (save 10 percent every Friday, keep
40 percent in cKES and rebalance weekly, send 5,000 cNGN on the 1st, stack 2 dollars
of CELO daily) and an autonomous OpenClaw agent runs it onchain forever on a 20-minute
heartbeat, paying gas in a stablecoin via Celo fee abstraction. No signing for
recurring actions. Funds stay in the user's own execution wallet, withdrawable anytime.

Built for everyday users in Lagos, Nairobi, and Johannesburg, where MiniPay adoption
is growing fastest.

- **Live:** https://remitroute.vercel.app
- **Onchain identity:** ERC-8004 agent **#9308** on Celo mainnet (chainId 42220), verifiable on agentscan.
- **Network:** Celo mainnet. Non-custodial. Gas paid in cUSD.

## The five money actions

| Action | Example rule | What it does |
|---|---|---|
| `savings_sweep` | "Save 10 percent every Friday" | Sweeps idle cUSD into Aave V3 yield on a cadence |
| `fx_rebalance` | "Keep 40 percent in cKES, rebalance weekly" | Holds a target currency mix, swapped on Mento with slippage protection |
| `remittance` | "Send 5,000 cNGN on the 1st" | Scheduled local-currency transfers |
| `dca` | "Stack 2 dollars of CELO daily" | Dollar-cost-average buys on a cadence |
| `withdrawal` | one tap | Pulls funds back to the user's MiniPay wallet |

## How it works

1. **Connect in MiniPay.** One tap, no seed phrase. The app authenticates each session
   with a MiniPay wallet signature; after that, recurring actions need no further signing.
2. **Set a rule in plain language.** `/api/parse-rule` turns it into a typed, capped
   schedule and reads it back before anything moves.
3. **The agent runs it onchain.** A deterministic heartbeat (systemd timer) wakes every
   ~20 minutes, runs a 6-guard loop (health check, load due rules, execute, post metrics,
   confirm, safety/halt), and fires whatever is due. Every action is stamped with a
   validation proof hash on the public dashboard.

## Safety

Real money on mainnet, so it is bounded and provable:

- **Spend caps** per transaction, per user per day, and global per day.
- **Circuit breaker** that halts the engine on a failure or volume anomaly.
- **Gas floor** that stops money movement when the stablecoin gas buffer runs low.
- **Idempotency** at the database level so a schedule can never double-execute across heartbeats.
- **Proof hash** per action, a deterministic keccak256 digest anyone can recompute.
- **Encrypted keys** at rest; `.env` is never committed.
- **MiniPay-signature auth** on every session, so only the wallet owner can act on their funds.

## Agent economy (x402)

RemitRoute exposes a paid FX-route API at `GET /api/fx-route` that other agents call
for a live cUSD-to-local-currency route and rate. Payment settles onchain on Celo via
x402 (returns HTTP 402 with payment requirements until paid).

## Public surfaces

| Route | What |
|---|---|
| `/` | Landing |
| `/app` | MiniPay Mini App (onboard, fund, set rules, withdraw) |
| `/dashboard` | Public live feed: actions by city, safety guardrails, proof hashes |
| `/how-it-works`, `/about`, `/docs` | Product and technical docs |
| `/.well-known/agent.json` | ERC-8004 machine-readable registration |
| `/api/fx-route` | x402 paid FX-route API |

## Tech stack

Celo mainnet, MiniPay, viem, Mento SDK (FX), Aave V3 (yield), ERC-8004 Identity +
Reputation registries, x402 (thirdweb facilitator), an OpenClaw heartbeat agent,
Neon Postgres (drizzle-orm), Next.js 15 (App Router), TypeScript.

## Layout

- `shared/` config, addresses, viem clients, fee-currency helper, key encryption, spend
  caps, circuit-breaker engine, proof hashing, db schema and client, ERC-8004 helpers.
- `openclaw/skills/*/scripts/` the typed viem scripts the agent invokes (transfer, swap,
  supply, rebalance, withdraw, post-metrics, run-due heartbeat).
- `app/` the Next.js Mini App (`app/app/`), the public dashboard (`app/dashboard/`), and
  the API routes (`app/api/`).
- `public/site/` the static marketing pages.
- `openclaw/deploy/` systemd unit and tunnel templates for the VPS.
- `registration/` the ERC-8004 registration document.

## Run it locally

1. `pnpm install`
2. `cp .env.example .env` and fill `DATABASE_URL` (Neon) plus `ENCRYPTION_KEY`
   (`openssl rand -hex 32`). Keep `DRY_RUN=true` and `AGENT_PRIVATE_KEY` empty to simulate.
3. `pnpm db:migrate` to apply the schema.
4. `pnpm dev` to serve the Mini App, or `pnpm build && pnpm start` for production.

Flip `DRY_RUN=false` only with a funded key and tiny caps; money movement runs through
the typed, capped scripts and the circuit breaker.

## Verify

- `pnpm typecheck`
- `pnpm skill:check-gas` reports the gas buffer against the floor.
- `tsx openclaw/skills/remitroute-core/scripts/verify-safety.ts` asserts caps, gas floor,
  idempotency, and the anomaly halt.

## Hard rules

- No em dashes anywhere, including code, comments, and UI copy.
- This moves real money on mainnet. Caps stay live, amounts stay tiny, keys are encrypted
  at rest, and `.env` is never committed.

## License

MIT. See [LICENSE](LICENSE).
