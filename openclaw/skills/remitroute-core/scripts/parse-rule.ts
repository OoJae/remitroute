// Natural-language rule parser. The model proposes a structured rule; zod
// validates it against the exact per-kind schemas; the first next_run is computed
// from the cadence; the result is returned for user confirmation and is NOT saved.
// Money still moves only through the typed skill scripts, never model output.
//
// Run: tsx openclaw/skills/remitroute-core/scripts/parse-rule.ts --user <id> --text "save 10 percent every Friday"
import { isAddress } from "viem";
import { db, pool } from "../../../../shared/db/client.js";
import { CadenceSchema, computeNextRun } from "../../../../shared/cadence.js";
import { ScheduleKind, validateParams } from "../../../../shared/scheduleParams.js";
import { parseStructured } from "../../../../shared/llm.js";
import { log } from "../../../../shared/log.js";

const ALLOWED_TOKENS = ["cUSD", "cKES", "cNGN", "cGHS", "cZAR", "cEUR", "CELO", "USDC", "USDT"];

const SYSTEM_PROMPT = `You convert a user's plain-language personal-finance rule into a single JSON object for RemitRoute, an autonomous agent on Celo. Reply with ONLY the JSON object, no prose, no code fences.

Schedule kinds and their params:
- remittance: send a stablecoin to someone. params: { "to": string (a 0x address if the user gave one, otherwise the recipient name or phone as text), "amount": string, "token": string }
- bill_drip: pay a biller on a schedule. params: same as remittance.
- dca: buy a target asset on a cadence. params: { "tokenIn": string (default "cUSD"), "tokenOut": string, "amount": string }
- savings_sweep: move idle funds into yield. params: { "asset": string (default "cUSD"), "pct": number between 0 and 1 }
- fx_rebalance: keep a basket at target weights. params: { "targets": { SYMBOL: weight, ... } weights are fractions that sum to 1 }
- yield_withdraw: take savings back out of yield to the wallet. params: { "asset": string (default "cUSD"), "amount": string (a number, or "max" for all) }

Allowed token symbols: ${ALLOWED_TOKENS.join(", ")}. Map "dollars"/"USD" to cUSD, "naira" to cNGN, "shillings"/"KES" to cKES, "cedis" to cGHS, "rand" to cZAR, "euro"/"EUR" to cEUR, "gold"/"CELO" to CELO.

Cadence grammar (pick one string): "once", "daily", "weekly", "weekly:<dow>" where dow is mon|tue|wed|thu|fri|sat|sun, "monthly:<dom>" where dom is 1..28, "every:<N>m" or "every:<N>h".
Map "every Friday" to "weekly:fri", "on the 1st" to "monthly:1", "every day"/"daily" to "daily", "weekly" to "weekly".

Output shape:
{ "kind": "<one kind>", "params": { ... }, "cadence": "<cadence string>", "summary": "<one short friendly sentence confirming the rule, no em dashes>" }

If the rule is ambiguous or not a finance rule, output { "error": "reason" }.`;

export interface ParsedRule {
  kind: string;
  params: Record<string, unknown>;
  cadence: string;
  nextRun: string;
  summary: string;
  needsRecipientResolution: boolean;
  warnings: string[];
}

export async function parseRule(userId: string, text: string): Promise<ParsedRule> {
  const raw = (await parseStructured(SYSTEM_PROMPT, text)) as Record<string, unknown>;
  if (raw.error) throw new Error(`could not parse rule: ${String(raw.error)}`);

  const kind = ScheduleKind.parse(raw.kind);
  const cadence = CadenceSchema.parse(raw.cadence);
  const params = validateParams(kind, raw.params);

  const next = computeNextRun(cadence) ?? new Date();
  const summary = typeof raw.summary === "string" ? raw.summary : `${kind} rule`;

  // For transfers, flag when the recipient is not yet a real address.
  let needsRecipientResolution = false;
  const warnings: string[] = [];
  if (kind === "remittance" || kind === "bill_drip") {
    const to = String((params as { to?: unknown }).to ?? "");
    if (!isAddress(to)) {
      needsRecipientResolution = true;
      warnings.push(`recipient "${to}" is not an address; confirm or resolve it before saving`);
    }
  }

  log.info({ userId, kind, cadence, needsRecipientResolution }, "rule parsed");
  return {
    kind,
    params,
    cadence,
    nextRun: next.toISOString(),
    summary,
    needsRecipientResolution,
    warnings,
  };
}

function parseCliArgs(argv: string[]): { user?: string; text?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined) {
        out[key] = val;
        i += 1;
      }
    }
  }
  return out;
}

const invokedDirectly = process.argv[1]?.endsWith("parse-rule.ts");
if (invokedDirectly) {
  const a = parseCliArgs(process.argv.slice(2));
  if (!a.user || !a.text) {
    log.error('usage: parse-rule.ts --user <id> --text "<rule>"');
    process.exit(1);
  }
  parseRule(a.user, a.text)
    .then(async (r) => {
      log.info({ rule: r }, "parsed");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(r, null, 2));
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err }, "parse-rule failed");
      await pool.end();
      process.exit(1);
    });
}
