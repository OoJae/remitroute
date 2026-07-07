// Deterministic idempotency key for a money-moving action. The engine reserves
// this id (a pending execution row) BEFORE broadcasting, so a crash-then-reclaim
// re-run of the same schedule slot recomputes the SAME id, hits the unique
// (user_id, intent_id) index, and skips the second broadcast instead of paying a
// recipient twice. It is derived from the schedule, user, kind, params, and the
// PRE-advance due slot (next_run at claim time) so it is stable across a reclaim
// but distinct across real cadence slots. Pure and dependency-light for testing.
import { createHash } from "node:crypto";

// Stable JSON: object keys sorted recursively, so equal params always serialize
// identically regardless of key insertion order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export interface IntentParts {
  scheduleId: string;
  userId: string;
  kind: string;
  params: unknown;
  dueSlot: string; // the schedule's next_run at claim time (pre-advance), ISO string
  suffix?: string; // distinguishes multiple actions of one schedule+slot (rebalance legs, pre-withdraw)
}

// Derive a distinct child intent id from a base id + a suffix (e.g. a rebalance
// leg's token pair), so multiple actions of one schedule slot each reserve their
// own row while staying deterministic across a reclaim re-run.
export function deriveIntentId(base: string, suffix: string): string {
  return createHash("sha256").update(`${base}|${suffix}`).digest("hex");
}

export function computeIntentId(parts: IntentParts): string {
  const canonical = [
    parts.scheduleId,
    parts.userId,
    parts.kind,
    canonicalJson(parts.params),
    parts.dueSlot,
    parts.suffix ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
