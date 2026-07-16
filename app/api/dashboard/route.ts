// Public dashboard data: a city-aggregated activity feed, a global recent-action
// ticker (each with a deterministic validation proof), the agent's ERC-8004
// reputation + live metrics, and x402 treasury revenue. Read-only; no money moves.
import { NextResponse } from "next/server";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../../shared/db/client.js";
import { executions, users, treasuryActions, feedbackLog, engineCycles } from "../../../shared/db/schema.js";
import { executionProofHash } from "../../../shared/proof.js";
import { config } from "../../../shared/config.js";
import { checkCaps } from "../../../shared/caps.js";
import { checkGasBuffer, type GasBufferResult } from "../../../openclaw/skills/fee-abstraction/scripts/check-gas-buffer.js";
import { getEngineState, duplicateExecutionCount } from "../../../shared/engine.js";
import {
  erc8004PublicClient,
  registries,
  reputationRegistryAbi,
} from "../../../shared/erc8004.js";
import { log } from "../../../shared/log.js";

const CAPS_PROBE_USER = "00000000-0000-0000-0000-000000000000";

// The gas check does an RPC read; cache it ~30s so the 15s dashboard poll stays cheap.
let gasCache: { at: number; value: GasBufferResult | null } = { at: 0, value: null };
async function cachedGas(): Promise<GasBufferResult | null> {
  const now = Date.now();
  if (now - gasCache.at < 30_000) return gasCache.value;
  let value: GasBufferResult | null = null;
  try {
    value = await checkGasBuffer();
  } catch (err) {
    log.warn({ err }, "gas buffer read failed for dashboard");
  }
  gasCache = { at: now, value };
  return value;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Round a (string-encoded) amount down to a single significant figure so the
// public ticker shows the rough scale of a transfer without disclosing the
// exact, individually-enumerable value. Null/zero/non-numeric pass through.
function bucketAmount(raw: string | null): string | null {
  if (raw == null) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return raw;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(n))));
  const bucket = Math.floor(n / mag) * mag;
  return String(bucket);
}

// Coarsen a timestamp to the top of the hour (UTC) so transfers cannot be
// ordered/correlated at second granularity from the public feed.
function coarseTimestamp(value: Date | string | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

const SCAN_URL = `https://8004scan.io/agents/celo/${config.AGENT_ID ?? ""}`;
const COMPLETED = sql`status in ('confirmed','success','dry_run')`;

// getSummary hits an RPC and needs an explicit client list (it reverts on an
// empty one), so cache the onchain reputation for 60s to keep polling cheap.
let onchainCache: { at: number; value: OnchainRep } = { at: 0, value: null };
type OnchainRep = { count: number; value: number } | null;

async function onchainReputation(clients: string[]): Promise<OnchainRep> {
  if (!config.AGENT_ID || clients.length === 0) return null;
  const now = Date.now();
  if (now - onchainCache.at < 60_000) return onchainCache.value;
  let value: OnchainRep = null;
  try {
    const res = (await erc8004PublicClient.readContract({
      address: registries.reputation,
      abi: reputationRegistryAbi,
      functionName: "getSummary",
      args: [BigInt(config.AGENT_ID), clients as `0x${string}`[], "starred", ""],
    })) as readonly [bigint, bigint, number];
    const decimals = Number(res[2]);
    value = { count: Number(res[0]), value: Number(res[1]) / 10 ** decimals };
  } catch (err) {
    log.warn({ err }, "onchain getSummary failed; showing offchain reputation only");
    value = null;
  }
  onchainCache = { at: now, value };
  return value;
}

export async function GET() {
  // Activity aggregated by city. We also count distinct users per city so we can
  // enforce k-anonymity below (city groups with fewer than CITY_MIN_USERS distinct
  // users are not individually identifiable and must be suppressed; pii-1/authz-6).
  const cityRows = await db
    .select({
      city: users.city,
      country: users.country,
      actions: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${COMPLETED})::int`,
      volume: sql<number>`coalesce(sum(${executions.amountIn}), 0)::float8`,
      distinctUsers: sql<number>`count(distinct ${executions.userId})::int`,
      lastAt: sql<string>`max(${executions.createdAt})`,
    })
    .from(executions)
    .leftJoin(users, eq(executions.userId, users.id))
    .groupBy(users.city, users.country)
    .orderBy(desc(sql`max(${executions.createdAt})`))
    .limit(50);

  // K-anonymity threshold: a city group must contain at least this many distinct
  // users before it can be shown with a city label and exact volume. Smaller
  // groups are folded into a single unlabelled "Other" bucket so individual
  // senders cannot be re-identified from a thinly populated city.
  const CITY_MIN_USERS = 3;

  const byCity = cityRows
    .filter((r) => r.distinctUsers >= CITY_MIN_USERS)
    .map((r) => ({
      city: r.city ?? "Unknown",
      country: r.country ?? null,
      actions: r.actions,
      completedRate: r.actions > 0 ? r.completed / r.actions : 0,
      volume: r.volume,
      lastAt: r.lastAt as string | null,
    }));

  // Fold every below-threshold city group into one aggregate "Other" bucket with
  // no city/country label, preserving totals without exposing sparse cities.
  const suppressed = cityRows.filter((r) => r.distinctUsers < CITY_MIN_USERS);
  if (suppressed.length > 0) {
    const actions = suppressed.reduce((s, r) => s + r.actions, 0);
    const completed = suppressed.reduce((s, r) => s + r.completed, 0);
    const lastAt = suppressed
      .map((r) => r.lastAt)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;
    byCity.push({
      city: "Other",
      country: null,
      actions,
      completedRate: actions > 0 ? completed / actions : 0,
      volume: suppressed.reduce((s, r) => s + r.volume, 0),
      lastAt,
    });
  }

  // Latest actions with a per-action validation proof.
  const recentRows = await db
    .select({
      id: executions.id,
      kind: executions.kind,
      status: executions.status,
      amountIn: executions.amountIn,
      tokenIn: executions.tokenIn,
      amountOut: executions.amountOut,
      tokenOut: executions.tokenOut,
      txHash: executions.txHash,
      createdAt: executions.createdAt,
      city: users.city,
      rationale: executions.rationale,
    })
    .from(executions)
    .leftJoin(users, eq(executions.userId, users.id))
    .orderBy(desc(executions.createdAt))
    .limit(25);

  const recent = recentRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    city: r.city ?? "Unknown",
    status: r.status,
    // Bucket amounts to 1 significant figure so individual transfers are not
    // enumerable from the public ticker; keep the token labels for context.
    amountIn: bucketAmount(r.amountIn),
    tokenIn: r.tokenIn,
    amountOut: bucketAmount(r.amountOut),
    tokenOut: r.tokenOut,
    // Raw txHash removed (pii-1): publishing it lets anyone link a city + kind +
    // amount to an onchain identity. The proof hash below still binds the full
    // action (including txHash) for independent verification without disclosing it.
    createdAt: coarseTimestamp(r.createdAt),
    proof: executionProofHash(r),
    // Why the agent took this action, captured at decision time. Safe to publish:
    // it describes the rule and the arithmetic, never a counterparty address (the
    // transfer paths phrase recipients as allowlist labels, not addresses).
    rationale: r.rationale,
  }));

  // x402 treasury revenue.
  const [t] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(nullif(regexp_replace(detail->>'price', '[^0-9.]', '', 'g'), '')::float8), 0)::float8`,
    })
    .from(treasuryActions)
    .where(eq(treasuryActions.strategy, "x402_payment"));
  const treasury = {
    count: t?.count ?? 0,
    totalUsd: t && t.total > 0 ? t.total : (t?.count ?? 0) * 0.01,
  };

  // Reputation: offchain mirror (feedback_log) plus optional onchain verification.
  const [f] = await db
    .select({
      count: sql<number>`count(*)::int`,
      avg: sql<number>`coalesce(avg(${feedbackLog.score}), 0)::float8`,
    })
    .from(feedbackLog);
  const clientRows = await db
    .selectDistinct({ c: feedbackLog.clientAddress })
    .from(feedbackLog)
    .where(isNotNull(feedbackLog.clientAddress));
  const clients = clientRows.map((r) => r.c).filter((c): c is string => Boolean(c));

  const reputation = {
    agentId: config.AGENT_ID ?? null,
    scanUrl: config.AGENT_ID ? SCAN_URL : null,
    feedbackCount: f?.count ?? 0,
    avgScore: f && f.count > 0 ? f.avg : null,
    onchain: await onchainReputation(clients),
  };

  // Live agent metrics from the whole executions ledger.
  const [m] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${COMPLETED})::int`,
      lastAt: sql<string>`max(${executions.createdAt})`,
    })
    .from(executions);
  const metrics = {
    totalActions: m?.total ?? 0,
    completedRate: m && m.total > 0 ? m.completed / m.total : 0,
    lastActivityAt: m?.lastAt ?? null,
  };

  // Safety guardrails (Phase 11): caps, gas floor, circuit breaker, idempotency.
  const caps = await checkCaps(CAPS_PROBE_USER, 0);
  const gas = await cachedGas();
  const engine = await getEngineState();
  const duplicates = await duplicateExecutionCount();
  const cycleRows = await db
    .select()
    .from(engineCycles)
    .orderBy(desc(engineCycles.createdAt))
    .limit(10);

  const safety = {
    engine: { status: engine.status, haltReason: engine.haltReason, haltedAt: engine.haltedAt },
    caps: {
      perTxCap: caps.perTxCap,
      perUserDailyCap: caps.perUserCap,
      globalDailyCap: caps.globalCap,
      globalSpentToday: caps.globalSpentToday,
    },
    gas: gas
      ? { floor: gas.floor, balance: gas.balance, pass: gas.pass, feeCurrency: gas.feeCurrency }
      : null,
    idempotency: { duplicates, ok: duplicates === 0 },
    recentCycles: cycleRows.map((c) => ({
      cycleId: c.cycleId,
      gasPass: c.gasPass,
      halted: c.halted,
      aborted: c.aborted,
      attempted: c.attempted,
      succeeded: c.succeeded,
      failed: c.failed,
      skipped: c.skipped,
      createdAt: c.createdAt,
    })),
  };

  // The autonomous FX treasury agent's own decision log. Each row is a real Mento
  // rebalance of the agent's multi-currency basket, stored with the drift that
  // triggered it and the sentence explaining it. This is the clearest public
  // evidence that the agent's on-chain activity is a decision rather than a loop.
  const treasuryRows = await db
    .select({
      strategy: treasuryActions.strategy,
      status: treasuryActions.status,
      detail: treasuryActions.detail,
      createdAt: treasuryActions.createdAt,
    })
    .from(treasuryActions)
    .where(eq(treasuryActions.strategy, "fx_treasury"))
    .orderBy(desc(treasuryActions.createdAt))
    .limit(15);

  const treasuryFeed = treasuryRows.map((r) => {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    return {
      status: r.status,
      from: (d.from as string) ?? null,
      to: (d.to as string) ?? null,
      amountUsd: d.amountUsd ?? null,
      driftBps: d.driftBps ?? null,
      rationale: (d.rationale as string) ?? null,
      createdAt: coarseTimestamp(r.createdAt),
    };
  });

  return NextResponse.json({ byCity, recent, treasury, treasuryFeed, reputation, metrics, safety });
}
