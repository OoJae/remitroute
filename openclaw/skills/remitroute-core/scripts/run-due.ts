// The heartbeat engine (Guardian 2 core). Loads due schedules and executes each
// one under an atomic claim so it can never double-execute, dispatches by kind,
// writes the execution ledger, and reschedules. Runs every cycle from the
// systemd timer. Money movement only happens through the typed skill functions,
// and every send is gated by DRY_RUN and the spend caps.
//
// Run: tsx openclaw/skills/remitroute-core/scripts/run-due.ts
import { erc20Abi, formatUnits } from "viem";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { schedules, executions, users } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { publicClient } from "../../../../shared/viem.js";
import { buyRoute, fleetX402Enabled } from "../../../../shared/fxRoute.js";
import { topUpPayerIfLow } from "../../../../shared/x402Topup.js";
import { log } from "../../../../shared/log.js";
import {
  TransferParams,
  DcaParams,
  SavingsParams,
  FxRebalanceParams,
  YieldWithdrawParams,
} from "../../../../shared/scheduleParams.js";
import { checkGasBuffer } from "../../fee-abstraction/scripts/check-gas-buffer.js";
import { send } from "../../transfer/scripts/send.js";
import { swap } from "../../mento-fx/scripts/swap.js";
import { supply } from "../../yield/scripts/supply.js";
import { withdraw } from "../../yield/scripts/withdraw.js";
import { rebalance } from "./rebalance.js";
import { postMetrics } from "../../erc8004/scripts/post-metrics.js";
import { reschedule } from "./reschedule.js";
import {
  getEngineState,
  haltEngine,
  resumeEngine,
  recordCycle,
  evaluateAnomaly,
} from "../../../../shared/engine.js";
import { notify, pingDeadman } from "../../../../shared/alerts.js";
import { flushReceipts } from "../../../../shared/receipts.js";
import { computeIntentId } from "../../../../shared/intent.js";

const TRANSFER_KINDS = new Set(["remittance", "bill_drip"]);

type Outcome = "ok" | "skipped" | "failed" | "reverted" | "unknown";

// Classify a money-script result and update the cycle summary. "unknown" is a
// broadcast whose fate we could not confirm: it is NOT counted as a failure (so
// it cannot trip the breaker) and is NEVER retried (so it cannot double-send).
// "reverted" is a real onchain revert (counts as a failure, but not retried
// since a deterministic revert will just fail again).
function account(summary: CycleSummary, status: string, volume: number): Outcome {
  if (status === "confirmed" || status === "success" || status === "dry_run") {
    summary.succeeded += 1;
    summary.volume += volume;
    return "ok";
  }
  if (status === "broadcast_unknown") return "unknown";
  if (status === "reverted") {
    summary.failed += 1;
    return "reverted";
  }
  if (status.startsWith("skipped")) {
    summary.skipped += 1;
    return "skipped";
  }
  summary.failed += 1;
  return "failed";
}

// Below this many whole units, a computed sweep amount is treated as dust.
const DUST = 0.000001;

// Read the execution wallet's idle balance of an asset, as a whole-unit number.
async function readIdleBalance(walletAddress: string, assetSymbol: string): Promise<number> {
  const token = resolveToken(assetSymbol);
  const raw = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  })) as bigint;
  return Number(formatUnits(raw, token.decimals));
}

export interface CycleSummary {
  cycleId: string;
  gasPass: boolean;
  loaded: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  volume: number;
  aborted: boolean;
}

export async function runDue(): Promise<CycleSummary> {
  const cycleId = crypto.randomUUID();
  const summary: CycleSummary = {
    cycleId,
    gasPass: false,
    loaded: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    volume: 0,
    aborted: false,
  };

  // Guardian 9 circuit breaker. If halted, move no money this cycle. Half-open
  // recovery: if it has been halted longer than the cooldown, auto-resume and
  // probe this cycle instead of staying wedged forever (a one-off burst should
  // not require a human). A persistent problem just re-trips the breaker.
  const engine = await getEngineState();
  if (engine.status === "halted") {
    const cooldownMs = config.ANOMALY_HALT_COOLDOWN_MIN * 60 * 1000;
    const haltedFor = engine.haltedAt ? Date.now() - engine.haltedAt.getTime() : Infinity;
    if (haltedFor >= cooldownMs) {
      await resumeEngine();
      await notify("engine auto-resumed after cooldown (half-open probe)", { haltedFor });
      log.warn({ cycleId, haltedFor }, "engine auto-resumed (half-open)");
    } else {
      summary.aborted = true;
      log.warn({ cycleId, reason: engine.haltReason }, "cycle skipped: engine halted");
      await recordCycle(summary, true);
      return summary;
    }
  }

  // Reclaim sweep: a schedule stuck in "processing" (a crash/SIGTERM mid-cycle)
  // is returned to active so it is not wedged forever; the due loader only sees
  // active rows.
  const staleBefore = new Date(Date.now() - config.RECLAIM_STALE_MIN * 60 * 1000);
  const reclaimed = await db
    .update(schedules)
    .set({ status: "active" })
    .where(and(eq(schedules.status, "processing"), lt(schedules.claimedAt, staleBefore)))
    .returning();
  if (reclaimed.length > 0) {
    log.warn({ cycleId, count: reclaimed.length }, "reclaimed stale processing schedules");
  }

  // Guardian 1 mini: gas buffer. In real mode a fail aborts the cycle so the
  // agent never strands itself. In DRY_RUN we log and continue so the loop is
  // testable without a funded treasury.
  const gas = await checkGasBuffer();
  summary.gasPass = gas.pass;
  if (!gas.pass && !config.DRY_RUN) {
    summary.aborted = true;
    log.error({ cycleId, balance: gas.balance, floor: gas.floor }, "cycle aborted: gas below floor");
    await recordCycle(summary, false);
    return summary;
  }

  // Load due, active schedules ordered by next_run. When FLEET_ONLY is set the
  // engine only ever touches agent-operated fleet wallets (users.is_fleet), which
  // quarantines real human users while the fleet runs live. Reversible by unsetting
  // the flag, and safer than trusting that no real schedules happen to exist.
  const fleetOnly = config.FLEET_ONLY
    ? sql`exists (select 1 from users u where u.id = ${schedules.userId} and u.is_fleet = true)`
    : undefined;
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.status, "active"), sql`${schedules.nextRun} <= now()`, fleetOnly))
    .orderBy(asc(schedules.nextRun));
  summary.loaded = due.length;

  for (const candidate of due) {
    // Atomic claim: flip active -> processing only if still due. If another
    // runner already claimed it, this returns no row and we skip.
    const claimed = await db
      .update(schedules)
      .set({ status: "processing", claimedAt: new Date() })
      .where(
        and(
          eq(schedules.id, candidate.id),
          eq(schedules.status, "active"),
          sql`${schedules.nextRun} <= now()`,
        ),
      )
      .returning();
    if (claimed.length === 0) continue;
    const sch = claimed[0]!;
    summary.attempted += 1;
    let outcome: Outcome = "ok";

    // Deterministic idempotency key for this schedule slot. Derived from the
    // PRE-advance next_run, so a crash-then-reclaim re-run of the same slot
    // recomputes the SAME id and the money script's pre-broadcast reservation
    // skips the duplicate. Threaded into every money dispatch below.
    const baseIntent = {
      scheduleId: sch.id,
      userId: sch.userId!,
      kind: sch.kind,
      params: sch.params,
      dueSlot: sch.nextRun.toISOString(),
    };
    const intentId = computeIntentId(baseIntent);

    try {
      if (TRANSFER_KINDS.has(sch.kind)) {
        const params = TransferParams.parse(sch.params);
        // If the wallet's idle balance is short, pull the token back from yield
        // first (best-effort), then send. The yield_withdraw row is a distinct
        // kind so it never collides with the transfer in the idempotency index.
        const [u] = await db.select().from(users).where(eq(users.id, sch.userId!));
        if (u) {
          const idle = await readIdleBalance(u.walletAddress, params.token);
          if (idle < Number(params.amount)) {
            try {
              // Top up only the shortfall (plus a tiny buffer), not the whole
              // yield position, to cover this transfer.
              const shortfall = (Number(params.amount) - idle + 0.001).toFixed(6);
              log.info({ scheduleId: sch.id, idle, need: params.amount, shortfall }, "remittance funds short; topping up from yield");
              await withdraw({ user: sch.userId!, asset: params.token, amount: shortfall, scheduleId: sch.id, cycleId, intentId: computeIntentId({ ...baseIntent, suffix: "prewithdraw" }) });
            } catch (e) {
              log.warn({ err: e, scheduleId: sch.id }, "pre-remittance yield withdraw failed; proceeding");
            }
          }
        }
        const res = await send({
          user: sch.userId!,
          to: params.to,
          amount: params.amount,
          token: params.token,
          kind: sch.kind as "remittance" | "bill_drip",
          scheduleId: sch.id,
          cycleId,
          intentId,
          rationale: `scheduled ${sch.cadence} ${sch.kind === "bill_drip" ? "bill payment" : "remittance"}: sending ${params.amount} ${params.token} to an allowlisted recipient`,
        });
        outcome = account(summary, res.status, Number(params.amount));
      } else if (sch.kind === "dca") {
        const params = DcaParams.parse(sch.params);
        const res = await swap({
          user: sch.userId!,
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amount,
          slippageBps: params.slippageBps,
          kind: "dca",
          scheduleId: sch.id,
          cycleId,
          intentId,
          rationale: `scheduled ${sch.cadence} buy: converting ${params.amount} ${params.tokenIn} into ${params.tokenOut}`,
        });
        outcome = account(summary, res.status, Number(params.amount));
      } else if (sch.kind === "savings_sweep") {
        const params = SavingsParams.parse(sch.params);
        const [u] = await db.select().from(users).where(eq(users.id, sch.userId!));
        if (!u) throw new Error(`unknown user ${sch.userId}`);
        const balance = await readIdleBalance(u.walletAddress, params.asset);
        const minLiquid = params.minLiquid ?? config.SWEEP_MIN_LIQUID;
        const available = Math.max(0, balance - minLiquid);
        const sweep = available * params.pct;
        log.info(
          { scheduleId: sch.id, asset: params.asset, balance, minLiquid, pct: params.pct, sweep },
          "savings_sweep computed",
        );
        if (sweep < DUST) {
          await db.insert(executions).values({
            scheduleId: sch.id,
            userId: sch.userId,
            cycleId,
            kind: "savings_sweep",
            status: "skipped_dust",
            tokenIn: params.asset,
            feeCurrency: config.FEE_CURRENCY,
            error: `sweep ${sweep} below dust threshold (balance ${balance}, minLiquid ${minLiquid})`,
          });
          summary.skipped += 1;
          outcome = "skipped";
        } else {
          // Trim to a sane precision so parseUnits in supply never overflows decimals.
          const amount = sweep.toFixed(6);
          const res = await supply({
            user: sch.userId!,
            asset: params.asset,
            amount,
            kind: "savings_sweep",
            scheduleId: sch.id,
            cycleId,
            intentId,
            rationale: `sweeping ${(params.pct * 100).toFixed(0)}% of idle ${params.asset} into Aave: ${amount} of ${available.toFixed(6)} available (balance ${balance.toFixed(6)}, keeping ${minLiquid} liquid)`,
          });
          outcome = account(summary, res.status, Number(amount));
        }
      } else if (sch.kind === "fx_rebalance") {
        const params = FxRebalanceParams.parse(sch.params);
        // Before an agent converts currency, it buys a priced route from our own
        // x402-monetized FX API, so the x402 payment is the by-product of a real
        // decision rather than a loop. Best effort: buyRoute returns null for a
        // non-fleet user, when disabled, or on any failure, and the rebalance then
        // runs exactly as before, unpriced.
        let routeNote = "";
        if (fleetX402Enabled()) {
          const corridor = Object.keys(params.targets).find((s) => s !== "cUSD");
          if (corridor) {
            // The route fee flows back to our own payTo, so recycle it rather than
            // letting each agent bleed its seed down and go quiet.
            const [payerRow] = await db.select().from(users).where(eq(users.id, sch.userId!));
            if (payerRow?.isFleet) await topUpPayerIfLow(payerRow.walletAddress);
            const priced = await buyRoute({
              userId: sch.userId!,
              tokenIn: "cUSD",
              tokenOut: corridor,
              amountIn: "1",
            });
            if (priced) routeNote = `bought a priced cUSD->${corridor} route over x402 at ${priced.rate}; `;
          }
        }
        const res = await rebalance(sch.userId!, params.targets, {
          driftThresholdBps: params.driftThresholdBps,
          slippageBps: params.slippageBps,
          scheduleId: sch.id,
          cycleId,
          intentId,
          routeNote,
        });
        // Only genuine failures count toward the breaker; broadcast_unknown legs
        // are NOT failures (never retried, may double-swap) and cap-skipped legs
        // are surfaced, not silently swallowed.
        summary.succeeded += res.swapsOk;
        summary.failed += res.swapsFailed;
        summary.volume += res.volume;
        if (res.swapsSkipped > 0) {
          await notify("fx_rebalance had cap-skipped legs; basket may be left unbalanced", { scheduleId: sch.id, skipped: res.swapsSkipped });
        }
        if (res.swapsFailed > 0 && res.swapsOk === 0) {
          outcome = "failed";
        } else if (res.swapsUnknown > 0 && res.swapsOk === 0 && res.swapsFailed === 0) {
          outcome = "unknown";
        } else if (res.swapsOk === 0 && res.swapsFailed === 0 && res.swapsUnknown === 0) {
          summary.skipped += 1;
          outcome = "skipped";
        }
      } else if (sch.kind === "yield_withdraw") {
        const params = YieldWithdrawParams.parse(sch.params);
        const res = await withdraw({
          user: sch.userId!,
          asset: params.asset,
          amount: params.amount,
          scheduleId: sch.id,
          cycleId,
          intentId,
        });
        outcome = account(summary, res.status, 0);
      } else {
        summary.skipped += 1;
        outcome = "skipped";
        log.warn({ scheduleId: sch.id, kind: sch.kind }, "unknown schedule kind, skipped");
      }
    } catch (err) {
      summary.failed += 1;
      outcome = "failed";
      log.error({ err, scheduleId: sch.id, kind: sch.kind }, "schedule execution failed");
    } finally {
      // Only a TRANSIENT failure (never-broadcast) is retried on the next
      // heartbeat, bounded by MAX_RETRIES. "reverted" (deterministic) and
      // "unknown" (possibly mined; retrying could double-send) are NEVER retried.
      // A schedule that keeps hard-failing across cadence slots auto-pauses so it
      // stops burning gas and stops tripping the breaker.
      const attempts = sch.retryCount ?? 0;
      const hardFail = outcome === "failed" || outcome === "reverted";
      const retriable = outcome === "failed" && attempts < config.MAX_RETRIES;
      try {
        if (retriable) {
          await db
            .update(schedules)
            .set({ status: "active", nextRun: new Date(), retryCount: attempts + 1 })
            .where(eq(schedules.id, sch.id));
          log.warn({ scheduleId: sch.id, kind: sch.kind, retry: attempts + 1 }, "transient failure; retrying next cycle");
        } else {
          const consec = (sch.consecutiveFailures ?? 0) + (hardFail ? 1 : 0);
          const resetConsec = outcome === "ok" || outcome === "skipped" ? 0 : consec;
          if (hardFail && TRANSFER_KINDS.has(sch.kind)) {
            await notify(`remittance schedule failed (${outcome}) after retries`, { scheduleId: sch.id, kind: sch.kind });
          }
          if (resetConsec >= config.MAX_CONSECUTIVE_FAILURES) {
            await db
              .update(schedules)
              .set({ status: "paused", retryCount: 0, consecutiveFailures: resetConsec })
              .where(eq(schedules.id, sch.id));
            await notify(`schedule auto-paused after ${resetConsec} consecutive failures`, { scheduleId: sch.id, kind: sch.kind });
          } else {
            await reschedule(sch.id);
            await db
              .update(schedules)
              .set({ retryCount: 0, consecutiveFailures: resetConsec })
              .where(eq(schedules.id, sch.id));
          }
        }
      } catch (err) {
        log.error({ err, scheduleId: sch.id }, "reschedule failed, leaving as active");
        await db.update(schedules).set({ status: "active" }).where(eq(schedules.id, sch.id));
      }
    }
  }

  // Guardian 3: early FX drift. For active fx_rebalance rules NOT yet due, trigger
  // an early rebalance only when a leg has drifted past the hard band (tighter than
  // the scheduled cadence). rebalance() no-ops unless a leg is past the threshold.
  try {
    const notDue = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, "active"),
          eq(schedules.kind, "fx_rebalance"),
          sql`${schedules.nextRun} > now()`,
          // Same fleet quarantine as the due query: the early-drift guardian must
          // not reach a real user's wallet either.
          fleetOnly,
        ),
      );
    for (const s of notDue) {
      try {
        const params = FxRebalanceParams.parse(s.params);
        const res = await rebalance(s.userId!, params.targets, {
          driftThresholdBps: config.HARD_DRIFT_BPS,
          slippageBps: params.slippageBps,
          scheduleId: s.id,
          cycleId,
        });
        if (res.swapsOk > 0 || res.swapsFailed > 0) {
          summary.succeeded += res.swapsOk;
          summary.failed += res.swapsFailed;
          summary.volume += res.volume;
          log.info({ scheduleId: s.id, ...res }, "Guardian 3 early rebalance");
        }
      } catch (err) {
        log.error({ err, scheduleId: s.id }, "Guardian 3 drift check failed");
      }
    }
  } catch (err) {
    log.error({ err, cycleId }, "Guardian 3 loop failed");
  }

  // Guardian 9: persist the cycle to the audit trail and trip the circuit
  // breaker on an anomaly (too many failures). Once halted it stays halted until
  // an operator clears it with engine-control --resume.
  let breakerTripped = false;
  try {
    await recordCycle(summary, false);
    const haltReason = evaluateAnomaly(summary);
    if (haltReason) {
      await haltEngine(haltReason);
      breakerTripped = true;
      log.error({ cycleId, failed: summary.failed }, haltReason);
    }
  } catch (err) {
    log.error({ err, cycleId }, "cycle audit or anomaly check failed");
  }

  // Guardian 7: post ERC-8004 metric tags from the monitoring wallet. No-ops
  // until AGENT_ID and the monitoring key are set; never breaks the cycle.
  try {
    await postMetrics();
  } catch (err) {
    log.error({ err }, "post-metrics failed in cycle");
  }

  log.info(
    {
      cycleId,
      loaded: summary.loaded,
      attempted: summary.attempted,
      succeeded: summary.succeeded,
      failed: summary.failed,
      skipped: summary.skipped,
      volume: summary.volume,
      gasPass: summary.gasPass,
      dryRun: config.DRY_RUN,
    },
    "heartbeat cycle summary",
  );

  // Dead-man liveness ping: fire only on a genuinely healthy cycle, so an external
  // watchdog (healthchecks.io etc.) treats a stalled engine OR a just-tripped
  // breaker as an alert. The early-return abort paths never reach here, so
  // summary.aborted is already false; the breaker guard covers the anomaly halt.
  // No-ops without DEADMAN_PING_URL and never throws.
  if (!summary.aborted && !breakerTripped) {
    await pingDeadman();
  }

  // Deliver the receipts queued during this cycle. They were dispatched
  // non-blocking so Telegram latency never serialized into the money loop;
  // draining here (before the process exits) makes sure none are dropped.
  await flushReceipts();
  return summary;
}

const invokedDirectly = process.argv[1]?.endsWith("run-due.ts");
if (invokedDirectly) {
  runDue()
    .then(async (s) => {
      await pool.end();
      process.exit(s.aborted ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "run-due failed");
      await pool.end();
      process.exit(1);
    });
}
