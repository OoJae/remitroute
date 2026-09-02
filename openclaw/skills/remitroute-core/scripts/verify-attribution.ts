// Decode a broadcast transaction and confirm our attribution tag actually rides
// in its calldata. The leaderboard credits only transactions carrying the tag
// assigned at registration, and a tag cannot be added after a transaction is
// sent, so this is the check that proves the loop is closed. Worth running
// against the first transaction of each kind, especially the two the USER signs
// (funding and rating), since those are what the adoption track scores.
//
// Run: tsx openclaw/skills/remitroute-core/scripts/verify-attribution.ts [--tx 0x...]
// With no --tx it verifies the most recent confirmed execution.
import { desc, isNotNull } from "drizzle-orm";
import { verifyTx, fromDataSuffix } from "@celo/attribution-tags";
import { db, pool } from "../../../../shared/db/client.js";
import { executions } from "../../../../shared/db/schema.js";
import { publicClient } from "../../../../shared/viem.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { config } from "../../../../shared/config.js";
import { log } from "../../../../shared/log.js";

function parseArgs(argv: string[]): { tx?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const v = argv[i + 1];
      if (v !== undefined) {
        out[a.slice(2)] = v;
        i += 1;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const expected = config.ATTRIBUTION_TAG;

  // Offline check first: a misconfigured tag is caught without an RPC round trip.
  if (!expected) {
    log.error("ATTRIBUTION_TAG is not set, so nothing we broadcast is credited");
    process.exitCode = 1;
    return;
  }
  const localCodes = fromDataSuffix(attributionSuffix() as `0x${string}`)?.codes ?? [];
  console.log(`configured tag: ${expected}`);
  console.log(`local suffix decodes to: ${JSON.stringify(localCodes)}`);
  if (!localCodes.includes(expected)) {
    log.error({ localCodes }, "local suffix does not contain the configured tag");
    process.exitCode = 1;
    return;
  }

  let hash = args.tx;
  if (!hash) {
    const [row] = await db
      .select({ txHash: executions.txHash })
      .from(executions)
      .where(isNotNull(executions.txHash))
      .orderBy(desc(executions.createdAt))
      .limit(1);
    hash = row?.txHash ?? undefined;
    if (!hash) {
      console.log("no transaction to check yet; pass --tx once one exists");
      return;
    }
    console.log(`no --tx given, using the latest execution: ${hash}`);
  }

  // verifyTx never throws; an RPC problem returns null, which we report as a
  // miss rather than a pass so a silent failure cannot look like success.
  const decoded = await verifyTx({ client: publicClient, hash: hash as `0x${string}` });
  if (!decoded) {
    log.error({ hash }, "no attribution suffix found onchain (or the tx could not be read)");
    process.exitCode = 1;
    return;
  }
  console.log(`onchain codes: ${JSON.stringify(decoded.codes)}`);
  if (decoded.codes.includes(expected)) {
    console.log(`TAG CONFIRMED onchain for ${hash}`);
  } else {
    log.error({ hash, codes: decoded.codes, expected }, "tag MISSING from this transaction");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    log.error({ err }, "verify-attribution failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
