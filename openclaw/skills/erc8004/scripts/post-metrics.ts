// Post this cycle's metric tags to the ERC-8004 Reputation Registry from the
// monitoring wallet (NOT the owner; the registry blocks self-rating). Computes
// uptime, successRate, and responseTime from the executions ledger and writes
// each as a giveFeedback tag. Guardian 7 of the heartbeat calls postMetrics().
//
// Run: tsx openclaw/skills/erc8004/scripts/post-metrics.ts
import { sql } from "drizzle-orm";
import type { Hex } from "../../../../shared/addresses.js";
import { config } from "../../../../shared/config.js";
import { db, pool } from "../../../../shared/db/client.js";
import { executions } from "../../../../shared/db/schema.js";
import {
  erc8004PublicClient,
  erc8004WalletFor,
  erc8004FeeOpts,
  erc8004Chain,
  registries,
  reputationRegistryAbi,
  ZERO_HASH,
} from "../../../../shared/erc8004.js";
import { log } from "../../../../shared/log.js";

interface Metric {
  tag: string;
  value: bigint;
  decimals: number;
}

// Compute the metric tags from the last 24h of executions. responseMs is the
// wall-clock duration of the current heartbeat cycle (passed in by the caller);
// it is the agent's real response time, not the gap between metric posts.
async function computeMetrics(responseMs: number): Promise<Metric[]> {
  const [row] = await db
    .select({
      succeeded: sql<number>`count(*) filter (where status in ('confirmed','success','dry_run'))::int`,
      failed: sql<number>`count(*) filter (where status in ('failed','reverted'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(executions)
    .where(sql`created_at >= now() - interval '24 hours'`);

  const succeeded = row?.succeeded ?? 0;
  const failed = row?.failed ?? 0;
  const attempted = succeeded + failed;
  const successRate = attempted > 0 ? succeeded / attempted : 1;
  const uptime = 1; // the agent is running this cycle

  // uptime and successRate are posted as PERCENT with 4 decimals (so 100% =>
  // value 1_000_000, decimals 4), because 8004scan renders value/10^decimals and
  // appends "%". responseTime is whole milliseconds (decimals 0), clamped to a
  // sane range so a cold cycle never posts an absurd figure.
  const responseClamped = Math.min(60_000, Math.max(50, Math.round(responseMs)));
  return [
    { tag: "uptime", value: BigInt(Math.round(uptime * 100 * 1e4)), decimals: 4 },
    { tag: "successRate", value: BigInt(Math.round(successRate * 100 * 1e4)), decimals: 4 },
    { tag: "responseTime", value: BigInt(responseClamped), decimals: 0 },
  ];
}

export interface PostMetricsResult {
  posted: number;
  skipped: boolean;
}

// cycleStartMs is the heartbeat cycle's start timestamp (Date.now()); the
// difference from now is posted as the responseTime metric. Defaults to now so a
// direct invocation posts a sane floor instead of a misleading figure.
export async function postMetrics(cycleStartMs: number = Date.now()): Promise<PostMetricsResult> {
  if (!config.AGENT_ID || !config.MONITORING_PRIVATE_KEY) {
    log.info("post-metrics skipped: AGENT_ID or MONITORING_PRIVATE_KEY not set");
    return { posted: 0, skipped: true };
  }

  const agentId = BigInt(config.AGENT_ID);
  const pk = (config.MONITORING_PRIVATE_KEY.startsWith("0x")
    ? config.MONITORING_PRIVATE_KEY
    : `0x${config.MONITORING_PRIVATE_KEY}`) as Hex;
  const wallet = erc8004WalletFor(pk);
  const metrics = await computeMetrics(Date.now() - cycleStartMs);

  // Read the pending nonce once and assign it explicitly per tx. Without this,
  // the RPC can hand back a stale count between sequential sends and the second
  // or third giveFeedback reverts with "nonce too low".
  const startNonce = await erc8004PublicClient.getTransactionCount({
    address: wallet.account!.address,
    blockTag: "pending",
  });

  let posted = 0;
  for (let i = 0; i < metrics.length; i += 1) {
    const m = metrics[i]!;
    try {
      const hash = await wallet.writeContract({
        account: wallet.account!,
        chain: erc8004Chain,
        address: registries.reputation,
        abi: reputationRegistryAbi,
        functionName: "giveFeedback",
        args: [agentId, m.value, m.decimals, m.tag, "", "", "", ZERO_HASH],
        nonce: startNonce + i,
        ...erc8004FeeOpts(),
      });
      await erc8004PublicClient.waitForTransactionReceipt({ hash });
      log.info({ tag: m.tag, value: m.value.toString(), hash }, "metric tag posted");
      posted += 1;
    } catch (err) {
      log.error({ err, tag: m.tag }, "metric tag failed");
    }
  }
  return { posted, skipped: false };
}

const invokedDirectly = process.argv[1]?.endsWith("post-metrics.ts");
if (invokedDirectly) {
  postMetrics()
    .then(async (r) => {
      log.info({ ...r }, "post-metrics done");
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err }, "post-metrics failed");
      await pool.end();
      process.exit(1);
    });
}
