// Applies SQL migrations in order, each at most once, tracked in a
// schema_migrations ledger and wrapped in a transaction so a failed migration
// rolls back cleanly. The .sql files remain idempotent (if-not-exists), so a
// first run against a pre-ledger database re-applies them harmlessly and records
// them.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";
import { log } from "../log.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

async function main() {
  await pool.query(
    "create table if not exists schema_migrations (filename text primary key, applied_at timestamptz default now())",
  );
  const appliedRows = await pool.query<{ filename: string }>("select filename from schema_migrations");
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      log.info({ file }, "migration already applied; skipping");
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    log.info({ file }, "applying migration");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1) on conflict do nothing", [file]);
      await client.query("commit");
      count += 1;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      log.error({ err, file }, "migration failed; rolled back");
      throw err;
    } finally {
      client.release();
    }
  }

  log.info({ applied: count, total: files.length }, "migrations complete");
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "migration runner failed");
  process.exit(1);
});
