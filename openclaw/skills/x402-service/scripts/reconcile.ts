// Reconcile settled x402 payments: summarize the x402_payment rows in
// treasury_actions so they show in activity and can back ERC-8004 feedback
// proofs. Each row is a paid fx-route call settled onchain.
//
// Run: tsx openclaw/skills/x402-service/scripts/reconcile.ts
import { desc, eq, sql } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { treasuryActions } from "../../../../shared/db/schema.js";
import { log } from "../../../../shared/log.js";

async function main(): Promise<void> {
  const [agg] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(treasuryActions)
    .where(eq(treasuryActions.strategy, "x402_payment"));

  const recent = await db
    .select()
    .from(treasuryActions)
    .where(eq(treasuryActions.strategy, "x402_payment"))
    .orderBy(desc(treasuryActions.createdAt))
    .limit(10);

  log.info({ totalX402Payments: agg?.count ?? 0 }, "x402 reconcile summary");
  for (const r of recent) {
    log.info({ id: r.id, createdAt: r.createdAt, detail: r.detail }, "x402 payment");
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "reconcile failed");
    await pool.end();
    process.exit(1);
  });
