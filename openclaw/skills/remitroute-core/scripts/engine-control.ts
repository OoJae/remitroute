// Operator control for the engine circuit breaker (Phase 11). Run on the VPS.
//   tsx engine-control.ts --status
//   tsx engine-control.ts --halt "reason for halting"
//   tsx engine-control.ts --resume
// Halt stops all money movement next cycle; resume is the manual reset that
// brings the engine back online (no silent auto-resume).
import { pool } from "../../../../shared/db/client.js";
import { getEngineState, haltEngine, resumeEngine } from "../../../../shared/engine.js";
import { log } from "../../../../shared/log.js";

function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = parseCliArgs(process.argv.slice(2));

  if (a.halt !== undefined) {
    const reason = typeof a.halt === "string" ? a.halt : "manual halt";
    await haltEngine(reason);
    log.warn({ reason }, "engine HALTED");
  } else if (a.resume !== undefined) {
    await resumeEngine();
    log.info("engine RESUMED");
  }

  const state = await getEngineState();
  log.info(
    { status: state.status, haltReason: state.haltReason, haltedAt: state.haltedAt },
    `engine status: ${state.status}`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "engine-control failed");
    await pool.end();
    process.exit(1);
  });
