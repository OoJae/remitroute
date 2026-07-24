// Single source of truth for schedule kinds and their params. The engine, the
// schedule-create paths, and the natural-language parser all validate against
// these exact schemas, so a rule can never reach execution malformed.
import { z } from "zod";
import { isAddress } from "viem";
import { TOKENS } from "./addresses.js";

export const SCHEDULE_KINDS = [
  "remittance",
  "bill_drip",
  "dca",
  "savings_sweep",
  "fx_rebalance",
  "yield_withdraw",
] as const;

export const ScheduleKind = z.enum(SCHEDULE_KINDS);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

const amount = z.string().refine((a) => Number(a) > 0, "amount must be positive");

// Tokens the direct-send path can actually move. Derived from TOKENS in
// addresses.ts so this allowlist can never drift from what resolveToken accepts;
// Mento local stables (cKES, cNGN, ...) are swap-only and deliberately absent.
export const SEND_TOKEN_SYMBOLS = Object.keys(TOKENS);

// Common names users type for send tokens, keyed lowercase. Exact-key lookup
// only, so usdc/usdt are never swallowed by the usd alias.
const SEND_TOKEN_ALIASES: Record<string, string> = {
  musd: "cUSD",
  usdm: "cUSD",
  usd: "cUSD",
  dollar: "cUSD",
  dollars: "cUSD",
  $: "cUSD",
  eur: "cEUR",
  euro: "cEUR",
  euros: "cEUR",
};

// Normalize a user-typed token name to a canonical send symbol. Unknown input is
// returned trimmed but unchanged so a validation error names what the user typed.
export function normalizeSendToken(raw: string): string {
  const trimmed = raw.trim();
  const alias = SEND_TOKEN_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  const canonical = SEND_TOKEN_SYMBOLS.find((s) => s.toLowerCase() === trimmed.toLowerCase());
  return canonical ?? trimmed;
}

// Send-token field shared by the strict and draft transfer schemas: default
// before transform so a missing token becomes cUSD, then normalize, then gate on
// the send allowlist so a rule with an unsendable token fails at creation with a
// clear message instead of reverting every cycle at execution.
const sendToken = z
  .string()
  .min(1)
  .default("cUSD")
  .transform(normalizeSendToken)
  .refine(
    (t) => t in TOKENS,
    (t) => ({ message: `token "${t}" cannot be sent directly; use one of ${SEND_TOKEN_SYMBOLS.join(", ")}` }),
  );

// remittance and bill_drip: send a stablecoin to a recipient. The recipient must
// be a valid address at save time so a malformed rule cannot be saved active and
// then revert every cycle (and the engine still resolves to a real allowlist
// check at execution time).
export const TransferParams = z.object({
  to: z.string().refine((a) => isAddress(a), "to must be a valid address"),
  amount,
  token: sendToken,
});

// Parse-time draft of TransferParams: `to` may still be free text (a name or a
// phone number) that the confirm step resolves to a real address before the
// strict save-time gate above runs. Amount and token are validated in full.
export const TransferDraftParams = z.object({
  to: z.string().min(1),
  amount,
  token: sendToken,
});

// dca: swap a fixed amount of tokenIn into tokenOut on a cadence.
export const DcaParams = z.object({
  tokenIn: z.string().min(1).default("cUSD"),
  tokenOut: z.string().min(1),
  amount,
  slippageBps: z.coerce.number().int().min(1).max(300).optional(),
});

// savings_sweep: supply a percentage of idle balance to yield.
export const SavingsParams = z.object({
  asset: z.string().min(1).default("cUSD"),
  pct: z.coerce.number().gt(0).max(1),
  minLiquid: z.coerce.number().min(0).optional(),
});

// fx_rebalance: keep a basket at target value weights. Weights should sum to ~1.
export const FxRebalanceParams = z.object({
  targets: z.record(z.coerce.number().gt(0).max(1)).refine((t) => Object.keys(t).length >= 2, {
    message: "targets must have at least two assets",
  }),
  driftThresholdBps: z.coerce.number().int().min(1).max(5000).optional(),
  slippageBps: z.coerce.number().int().min(1).max(300).optional(),
});

// yield_withdraw: pull a stablecoin back out of Aave to the execution wallet.
export const YieldWithdrawParams = z.object({
  asset: z.string().min(1).default("cUSD"),
  amount: z.string().refine((a) => a === "max" || Number(a) > 0, "amount must be positive or max"),
});

const PARAM_SCHEMAS = {
  remittance: TransferParams,
  bill_drip: TransferParams,
  dca: DcaParams,
  savings_sweep: SavingsParams,
  fx_rebalance: FxRebalanceParams,
  yield_withdraw: YieldWithdrawParams,
} as const;

// Validate and normalize params for a given kind. Throws on an invalid shape.
export function validateParams(kind: ScheduleKind, params: unknown): Record<string, unknown> {
  const schema = PARAM_SCHEMAS[kind];
  return schema.parse(params) as Record<string, unknown>;
}

// Parse-time variant: transfer kinds use the draft schema (free-text recipient,
// full amount and token validation) so the parser can hand an unresolved
// recipient to the confirm step instead of rejecting it; every other kind is
// exactly as strict as save time.
export function validateDraftParams(kind: ScheduleKind, params: unknown): Record<string, unknown> {
  if (kind === "remittance" || kind === "bill_drip") {
    return TransferDraftParams.parse(params) as Record<string, unknown>;
  }
  return validateParams(kind, params);
}

export type TransferParamsType = z.infer<typeof TransferParams>;
export type DcaParamsType = z.infer<typeof DcaParams>;
export type SavingsParamsType = z.infer<typeof SavingsParams>;
export type FxRebalanceParamsType = z.infer<typeof FxRebalanceParams>;
export type YieldWithdrawParamsType = z.infer<typeof YieldWithdrawParams>;
