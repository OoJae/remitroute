// The heartbeat engine (Guardian 2 core). Loads due schedules and executes each
// one under an atomic claim so it can never double-execute, dispatches by kind,
// writes the execution ledger, and reschedules. Runs every cycle from the
// systemd timer. Money movement only happens through the typed skill functions,
// and every send is gated by DRY_RUN and the spend caps.
//
// Run: tsx openclaw/skills/remitroute-core/scripts/run-due.ts
import { erc20Abi, formatUnits } from "viem";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { schedules, executions, users } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { publicClient } from "../../../../shared/viem.js";
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
import { getEngineState, haltEngine, recordCycle, evaluateAnomaly } from "../../../../shared/engine.js";

const TRANSFER_KINDS = new Set(["remittance", "bill_drip"]);

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
  const cycleStartMs = Date.now();
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

  // Guardian 9 circuit breaker: if the engine is halted, move no money this
  // cycle. It stays halted until an operator clears it (engine-control --resume).
  const engine = await getEngineState();
  if (engine.status === "halted") {
    summary.aborted = true;
    log.warn({ cycleId, reason: engine.haltReason }, "cycle skipped: engine halted");
    await recordCycle(summary, true);
    return summary;
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

  // Load due, active schedules ordered by next_run.
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.status, "active"), sql`${schedules.nextRun} <= now()`))
    .orderBy(asc(schedules.nextRun));
  summary.loaded = due.length;

  for (const candidate of due) {
    // Atomic claim: flip active -> processing only if still due. If another
    // runner already claimed it, this returns no row and we skip.
    const claimed = await db
      .update(schedules)
      .set({ status: "processing" })
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
    let outcome: "ok" | "skipped" | "failed" = "ok";

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
              log.info({ scheduleId: sch.id, idle, need: params.amount }, "remittance funds short; withdrawing from yield first");
              await withdraw({ user: sch.userId!, asset: params.token, amount: "max", scheduleId: sch.id, cycleId });
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
        });
        if (res.status === "confirmed" || res.status === "dry_run") {
          summary.succeeded += 1;
          summary.volume += Number(params.amount);
        } else if (res.status === "skipped_cap") {
          summary.skipped += 1;
          outcome = "skipped";
        } else {
          summary.failed += 1;
          outcome = "failed";
        }
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
        });
        if (res.status === "confirmed" || res.status === "dry_run") {
          summary.succeeded += 1;
          summary.volume += Number(params.amount);
        } else if (res.status === "skipped_cap") {
          summary.skipped += 1;
          outcome = "skipped";
        } else {
          summary.failed += 1;
          outcome = "failed";
        }
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
          });
          if (res.status === "confirmed" || res.status === "dry_run") {
            summary.succeeded += 1;
            summary.volume += Number(amount);
          } else if (res.status === "skipped_cap") {
            summary.skipped += 1;
            outcome = "skipped";
          } else {
            summary.failed += 1;
            outcome = "failed";
          }
        }
      } else if (sch.kind === "fx_rebalance") {
        const params = FxRebalanceParams.parse(sch.params);
        const res = await rebalance(sch.userId!, params.targets, {
          driftThresholdBps: params.driftThresholdBps,
          slippageBps: params.slippageBps,
          scheduleId: sch.id,
          cycleId,
        });
        summary.succeeded += res.swapsOk;
        summary.failed += res.swapsFailed;
        summary.volume += res.volume;
        if (res.swapsOk === 0 && res.swapsFailed === 0) {
          summary.skipped += 1;
          outcome = "skipped";
        } else if (res.swapsOk === 0 && res.swapsFailed > 0) {
          outcome = "failed";
        }
      } else if (sch.kind === "yield_withdraw") {
        const params = YieldWithdrawParams.parse(sch.params);
        const res = await withdraw({
          user: sch.userId!,
          asset: params.asset,
          amount: params.amount,
          scheduleId: sch.id,
          cycleId,
        });
        if (res.status === "confirmed" || res.status === "dry_run") {
          summary.succeeded += 1;
        } else {
          summary.failed += 1;
          outcome = "failed";
        }
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
      // Guardians 4/5/6: a transient failure is retried on the NEXT heartbeat
      // (the idempotency index forbids a same-cycle re-run), bounded by
      // MAX_RETRIES. Otherwise advance to the next cadence and reset the counter.
      // A remittance/bill_drip that exhausts its retries raises an operator alert.
      const attempts = sch.retryCount ?? 0;
      const retriable = outcome === "failed" && attempts < config.MAX_RETRIES;
      try {
        if (retriable) {
          await db
            .update(schedules)
            .set({ status: "active", nextRun: new Date(), retryCount: attempts + 1 })
            .where(eq(schedules.id, sch.id));
          log.warn({ scheduleId: sch.id, kind: sch.kind, retry: attempts + 1 }, "transient failure; retrying next cycle");
        } else {
          if (outcome === "failed" && TRANSFER_KINDS.has(sch.kind)) {
            log.error({ scheduleId: sch.id, kind: sch.kind }, "OPERATOR ALERT: remittance failed after retries");
          }
          await reschedule(sch.id);
          await db.update(schedules).set({ retryCount: 0 }).where(eq(schedules.id, sch.id));
        }
      } catch (err) {
        log.error({ err, scheduleId: sch.id }, "reschedule failed, leaving as active");
        await db
          .update(schedules)
          .set({ status: "active" })
          .where(eq(schedules.id, sch.id));
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
  try {
    await recordCycle(summary, false);
    const haltReason = evaluateAnomaly(summary);
    if (haltReason) {
      await haltEngine(haltReason);
      log.error({ cycleId, failed: summary.failed }, haltReason);
    }
  } catch (err) {
    log.error({ err, cycleId }, "cycle audit or anomaly check failed");
  }

  // Guardian 7: post ERC-8004 metric tags from the monitoring wallet. No-ops
  // until AGENT_ID and the monitoring key are set; never breaks the cycle.
  try {
    await postMetrics(cycleStartMs);
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
