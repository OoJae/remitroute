// One-off backfill for the recipient allowlist (M-5). Every remittance/bill_drip
// schedule was created through the authenticated schedules API, so its params.to
// is already a user-confirmed recipient. Schedules created before the allowlist
// existed have no recipients row, so the new enforcement in send.ts would skip
// them; this seeds those confirmed recipients so existing schedules keep paying.
// Idempotent: inserts only addresses not already allowlisted (safe to re-run).
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { schedules, recipients } from "../../../../shared/db/schema.js";
import { log } from "../../../../shared/log.js";

async function main(): Promise<void> {
  const rows = await db
    .select()
    .from(schedules)
    .where(inArray(schedules.kind, ["remittance", "bill_drip"]));

  let inserted = 0;
  let already = 0;
  let skipped = 0;
  for (const s of rows) {
    const to = (s.params as Record<string, unknown> | null)?.to;
    if (typeof to !== "string" || !s.userId) {
      skipped += 1;
      continue;
    }
    const existing = await db
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(eq(recipients.userId, s.userId), sql`lower(${recipients.address}) = lower(${to})`))
      .limit(1);
    if (existing.length > 0) {
      already += 1;
      continue;
    }
    try {
      await db.insert(recipients).values({ userId: s.userId, address: to });
      inserted += 1;
    } catch {
      // Unique-index race or concurrent insert: already allowlisted.
      already += 1;
    }
  }
  log.info({ scanned: rows.length, inserted, already, skipped }, "recipient allowlist backfill complete");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "recipient backfill failed");
    await pool.end();
    process.exit(1);
  });
