// Provision a fleet of agent-operated wallets so the autonomous engine's activity
// comes from many distinct addresses running real rules, instead of one treasury
// wallet trading with itself.
//
// Each fleet member is a real user row with its own encrypted execution wallet, a
// cUSD float, an allowlisted peer, and a spread of live schedules (dca,
// fx_rebalance, savings_sweep, remittance). The heartbeat then executes them like
// any other user: same typed money scripts, same spend caps, same idempotency,
// same attribution suffix. The volume that results is the by-product of rules
// firing, and every row carries the reason it fired.
//
// These are OUR wallets holding agent float, not human funds, and they are marked
// users.is_fleet so run-due can be restricted to them (FLEET_ONLY) while the
// engine runs live, quarantining any real human user.
//
// Real money on mainnet, so it is preview-by-default and double-capped: no single
// transfer exceeds FLEET_FUND_MAX_CUSD, and the whole run cannot spend more than
// FLEET_FUND_TOTAL_MAX.
//
//   tsx provision-fleet.ts --count 12 --float 3            (preview)
//   tsx provision-fleet.ts --count 12 --float 3 --execute  (real)
import { eq, sql } from "drizzle-orm";
import { erc20Abi, formatUnits, getAddress } from "viem";
import { db, pool } from "../../../../shared/db/client.js";
import { users, recipients, schedules } from "../../../../shared/db/schema.js";
import { createExecutionWallet } from "../../../../shared/wallet.js";
import { publicClient } from "../../../../shared/viem.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { createSchedule } from "./create-schedule.js";
import { fundExec } from "../../transfer/scripts/fund-exec.js";
import { log } from "../../../../shared/log.js";

// Celo's base fee moves between transfers, so a sequential funding run will hit
// "fee cap lower than block base fee" on some legs. It is transient: re-estimating
// a few seconds later succeeds. Retry rather than abandoning a half-funded fleet.
async function fundWithRetry(to: string, amount: string, attempts = 4, token?: string): Promise<string | null> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fundExec({ to, amount, execute: true, token });
    } catch (err) {
      const msg = (err as Error).message;
      log.warn({ to, attempt: i, err: msg.slice(0, 120) }, "fund attempt failed; retrying");
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  return null;
}

async function tokenBalance(address: string, symbol: string): Promise<number> {
  const token = resolveToken(symbol);
  const raw = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  })) as bigint;
  return Number(formatUnits(raw, token.decimals));
}
const cusdBalance = (address: string) => tokenBalance(address, "cUSD");

// These wallets are ours, not customers, and they are named so that nobody can
// mistake them for people. The country only selects which corridor currency the
// member trades; the public dashboard excludes is_fleet rows from its user-facing
// city aggregates precisely so a fleet wallet is never counted as a real user.
const PLACES: Array<{ city: string; country: string }> = [
  { city: "Lagos", country: "NG" },
  { city: "Nairobi", country: "KE" },
  { city: "Accra", country: "GH" },
  { city: "Johannesburg", country: "ZA" },
];

// A spread of rules per member so the fleet exercises every money path. Cadences
// are staggered and never finer than the 20 minute heartbeat, and nextRun offsets
// keep them from all firing in the same cycle.
const RULES = [
  { kind: "dca", cadence: "every:20m", nextRun: "+1m", params: (p: string) => ({ tokenIn: "cUSD", tokenOut: p, amount: "0.05", slippageBps: 100 }) },
  { kind: "fx_rebalance", cadence: "every:40m", nextRun: "+5m", params: (p: string) => ({ targets: { cUSD: 0.6, [p]: 0.4 } }) },
  { kind: "savings_sweep", cadence: "every:1h", nextRun: "+9m", params: () => ({ asset: "cUSD", pct: 0.2, minLiquid: 1 }) },
];

// Which currency each city's members trade into: the corridor they would actually
// use, which is also what makes the fleet's pairs diverse.
const CORRIDOR: Record<string, string> = { NG: "cNGN", KE: "cKES", GH: "cGHS", ZA: "cZAR" };

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const count = Math.max(1, Number(arg("--count", "12")));
  const float = Number(arg("--float", "3"));
  const execute = process.argv.includes("--execute");
  const perMax = Number(process.env.FLEET_FUND_MAX_CUSD ?? 5);
  const totalMax = Number(process.env.FLEET_FUND_TOTAL_MAX ?? 60);

  if (float <= 0 || float > perMax) throw new Error(`--float must be > 0 and <= FLEET_FUND_MAX_CUSD (${perMax})`);
  const totalSpend = count * float;
  if (totalSpend > totalMax) {
    throw new Error(`fleet would spend ${totalSpend} cUSD, over FLEET_FUND_TOTAL_MAX (${totalMax})`);
  }

  // --count is the TARGET fleet size, not a number to add, so this script is
  // resumable: a run that died half way (a transient gas-fee race mid-funding)
  // is fixed by running it again rather than by hand-repairing state.
  const existingRows = await db
    .select({ id: users.id, address: users.walletAddress, city: users.city, country: users.country })
    .from(users)
    .where(eq(users.isFleet, true));
  const toMint = Math.max(0, count - existingRows.length);
  log.info(
    { target: count, existingFleet: existingRows.length, toMint, float, totalSpend, perMax, totalMax, execute },
    execute ? "provisioning fleet" : "PREVIEW only; rerun with --execute",
  );
  if (!execute) {
    await pool.end();
    return;
  }

  const created: Array<{ id: string; address: string; city: string; corridor: string }> = existingRows.map((r) => ({
    id: r.id,
    address: r.address,
    city: r.city ?? "Lagos",
    corridor: CORRIDOR[r.country ?? "NG"] ?? "cKES",
  }));

  for (let i = existingRows.length; i < existingRows.length + toMint; i += 1) {
    const place = PLACES[i % PLACES.length]!;
    const name = `Agent ${String(i + 1).padStart(2, "0")}`;
    const corridor = CORRIDOR[place.country] ?? "cKES";
    const w = createExecutionWallet();
    const [row] = await db
      .insert(users)
      .values({
        displayName: name,
        city: place.city,
        country: place.country,
        walletAddress: w.address,
        walletKeyRef: w.keyRef,
        isFleet: true,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to insert fleet user");
    created.push({ id: row.id, address: w.address, city: place.city, corridor });
    log.info({ i, city: place.city, address: w.address }, "fleet wallet minted");
  }

  // Fund only what is actually short, so a rerun tops up a half-funded fleet
  // instead of double-paying. The float covers trading and gas together, because
  // gas is paid in cUSD via fee abstraction; no native CELO seeding is needed.
  let spent = 0;
  for (const m of created) {
    const have = await cusdBalance(m.address);
    if (have >= float - 0.01) continue;
    const need = Math.min(float - have, perMax);
    if (spent + need > totalMax) {
      log.warn({ spent, need, totalMax }, "aggregate funding cap reached; stopping funding");
      break;
    }
    await fundWithRetry(m.address, need.toFixed(6));
    spent += need;
  }
  log.info({ spent }, "fleet funded");

  // x402 working capital. The paid FX route is priced in USDC (the Celo stable
  // with a standard EIP-3009 permit domain), so an agent that pays for a route
  // needs a small USDC float. It needs nothing else: the payer only signs, so no
  // gas and no approval. Idempotent, like the cUSD leg.
  const usdcFloat = Number(process.env.X402_FLEET_USDC_FLOAT ?? 0.5);
  if (usdcFloat > 0) {
    let usdcSpent = 0;
    for (const m of created) {
      const have = await tokenBalance(m.address, "USDC");
      if (have >= usdcFloat - 0.001) continue;
      const need = usdcFloat - have;
      const ownerUsdc = await tokenBalance(getAddress(process.env.AGENT_WALLET_ADDRESS ?? ""), "USDC").catch(() => 0);
      if (ownerUsdc < need) {
        log.warn({ ownerUsdc, need }, "owner USDC exhausted; remaining agents will pay no routes until topped up");
        break;
      }
      await fundWithRetry(m.address, need.toFixed(6), 4, "USDC");
      usdcSpent += need;
    }
    log.info({ usdcSpent, usdcFloat }, "fleet x402 float seeded");
  }

  // Allowlist a peer for each member (send() refuses any address not on the
  // user's allowlist) and seed the rules. Skip anyone already seeded so a rerun
  // does not duplicate schedules.
  for (let i = 0; i < created.length; i += 1) {
    const me = created[i]!;
    const peer = created[(i + 1) % created.length]!;
    const seeded = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schedules)
      .where(eq(schedules.userId, me.id));
    if ((seeded[0]?.n ?? 0) > 0) continue;

    await db
      .insert(recipients)
      .values({ userId: me.id, address: peer.address, label: `${peer.city} agent peer` });

    for (const rule of RULES) {
      await createSchedule({
        user: me.id,
        kind: rule.kind as never,
        params: rule.params(me.corridor) as never,
        cadence: rule.cadence,
        nextRun: rule.nextRun,
      });
    }
    // A remittance to the allowlisted peer, so the transfer path runs too.
    await createSchedule({
      user: me.id,
      kind: "remittance" as never,
      params: { to: peer.address, amount: "0.02", token: "cUSD" } as never,
      cadence: "every:1h",
      nextRun: "+13m",
    });
    log.info({ member: me.address, corridor: me.corridor }, "fleet member rules seeded");
  }

  log.info({ members: created.length, spent }, "fleet provisioned: wallets, funding, allowlists and rules");
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.error({ err }, "provision-fleet failed");
    try { await pool.end(); } catch {}
    process.exit(1);
  });
