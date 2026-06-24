// Single source of truth for schedule kinds and their params. The engine, the
// schedule-create paths, and the natural-language parser all validate against
// these exact schemas, so a rule can never reach execution malformed.
import { z } from "zod";
import { isAddress } from "viem";

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

// remittance and bill_drip: send a stablecoin to a recipient. The recipient must
// be a valid address at save time so a malformed rule cannot be saved active and
// then revert every cycle (and the engine still resolves to a real allowlist
// check at execution time).
export const TransferParams = z.object({
  to: z.string().refine((a) => isAddress(a), "to must be a valid address"),
  amount,
  token: z.string().min(1).default("cUSD"),
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

export type TransferParamsType = z.infer<typeof TransferParams>;
export type DcaParamsType = z.infer<typeof DcaParams>;
export type SavingsParamsType = z.infer<typeof SavingsParams>;
export type FxRebalanceParamsType = z.infer<typeof FxRebalanceParams>;
export type YieldWithdrawParamsType = z.infer<typeof YieldWithdrawParams>;
