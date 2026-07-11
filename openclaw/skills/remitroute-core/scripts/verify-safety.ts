// Safety proof harness (Phase 11). Actively asserts each guardrail and exits
// 0 (all pass) or 1 (any fail). Read-only except for a halt/resume self-test on
// the circuit breaker, whose prior state is restored at the end.
//   tsx openclaw/skills/remitroute-core/scripts/verify-safety.ts
import { pool } from "../../../../shared/db/client.js";
import { config } from "../../../../shared/config.js";
import { checkCaps } from "../../../../shared/caps.js";
import { checkGasBuffer } from "../../fee-abstraction/scripts/check-gas-buffer.js";
import {
  getEngineState,
  haltEngine,
  resumeEngine,
  duplicateExecutionCount,
} from "../../../../shared/engine.js";
import { lockedUsdFor } from "../../../../shared/goals.js";
import { lockBreached, goalLockedUsd } from "../../../../shared/goalMath.js";
import { log } from "../../../../shared/log.js";

const TEST_USER = "00000000-0000-0000-0000-000000000000";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function checkCapsGuardrail(): Promise<Check> {
  const within = await checkCaps(TEST_USER, 0.01);
  const overTx = await checkCaps(TEST_USER, config.PER_TX_CAP + 1);
  const overDaily = await checkCaps(TEST_USER, config.GLOBAL_DAILY_CAP + 1);
  const pass =
    within.allowed &&
    !overTx.allowed &&
    /per-transaction/.test(overTx.reason ?? "") &&
    !overDaily.allowed;
  return {
    name: "caps",
    pass,
    detail: `perTx=${config.PER_TX_CAP} perUser=${config.PER_USER_DAILY_CAP} global=${config.GLOBAL_DAILY_CAP}; within-cap allowed=${within.allowed}, over-tx blocked=${!overTx.allowed}, over-daily blocked=${!overDaily.allowed}`,
  };
}

async function checkGasGuardrail(): Promise<Check> {
  const gas = await checkGasBuffer();
  // The guardrail is present if the check returns a sane floor and decision.
  const pass = gas.floor > 0 && typeof gas.pass === "boolean";
  return {
    name: "gas-floor",
    pass,
    detail: `floor=${gas.floor} ${gas.feeCurrency}, balance=${gas.balance}, aboveFloor=${gas.pass}`,
  };
}

async function checkIdempotencyGuardrail(): Promise<Check> {
  const dupes = await duplicateExecutionCount();
  const idx = await pool.query(
    "select 1 from pg_indexes where indexname = $1",
    ["executions_schedule_cycle_uq"],
  );
  const indexExists = (idx.rowCount ?? 0) > 0;
  return {
    name: "idempotency",
    pass: dupes === 0 && indexExists,
    detail: `duplicate (schedule,cycle,token) rows=${dupes}, unique index present=${indexExists}`,
  };
}

async function checkAnomalyHaltGuardrail(): Promise<Check> {
  const before = await getEngineState();
  try {
    await haltEngine("verify-safety self-test");
    const halted = await getEngineState();
    await resumeEngine();
    const resumed = await getEngineState();
    const pass = halted.status === "halted" && resumed.status === "running";
    return {
      name: "anomaly-halt",
      pass,
      detail: `halt->${halted.status}, resume->${resumed.status}, trigger=${config.ANOMALY_MAX_FAILURES} failures/cycle, enabled=${config.ANOMALY_HALT_ENABLED}`,
    };
  } finally {
    // Restore the pre-test state so the self-test never leaves the engine halted.
    if (before.status === "halted") await haltEngine(before.haltReason ?? "restored");
    else await resumeEngine();
  }
}

async function checkGoalLockGuardrail(): Promise<Check> {
  // The pure gate math: a locked goal blocks a withdrawal that dips below the
  // locked floor, and never spuriously blocks when nothing is locked.
  const gateOk =
    lockBreached(1.0, 1.0, 0.5) &&
    lockBreached(0.6, 1.0, 0.5) &&
    !lockBreached(0.5, 1.0, 0.5) &&
    !lockBreached(1.0, 1.0, 0) &&
    goalLockedUsd(12, 10) === 10 &&
    goalLockedUsd(3, 10) === 3;
  // The lock query executes against the live schema and returns a sane figure
  // (catches a column rename / broken query that would silently report 0).
  const summary = await lockedUsdFor(TEST_USER, "cUSD");
  const queryOk = Number.isFinite(summary.lockedUsd) && summary.lockedUsd >= 0;
  return {
    name: "goal-lock",
    pass: gateOk && queryOk,
    detail: `gate math=${gateOk}, lock query ok=${queryOk} (lockedUsd=${summary.lockedUsd} for the probe user)`,
  };
}

async function main(): Promise<void> {
  const checks = [
    await checkCapsGuardrail(),
    await checkGasGuardrail(),
    await checkIdempotencyGuardrail(),
    await checkAnomalyHaltGuardrail(),
    await checkGoalLockGuardrail(),
  ];

  for (const c of checks) {
    log.info({ guardrail: c.name, detail: c.detail }, `${c.pass ? "PASS" : "FAIL"}: ${c.name}`);
  }
  const allPass = checks.every((c) => c.pass);
  log.info({ allPass, passed: checks.filter((c) => c.pass).length, total: checks.length }, allPass ? "SAFETY PROOF: all guardrails PASS" : "SAFETY PROOF: FAILURES present");

  await pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  log.error({ err }, "verify-safety failed");
  await pool.end();
  process.exit(1);
});
