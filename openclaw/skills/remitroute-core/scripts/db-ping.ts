// Phase 0 smoke test: prove a skill script can read Postgres.
// Run: pnpm db:ping
import { sql } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { log } from "../../../../shared/log.js";

async function main() {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  log.info({ userCount: row?.count ?? 0 }, "db-ping ok: users table is reachable");
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "db-ping failed");
  process.exit(1);
});
