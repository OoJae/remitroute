// Applies the raw SQL migrations in order. Idempotent (every statement uses
// "if not exists"), so it is safe to run repeatedly.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";
import { log } from "../log.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    log.info({ file }, "applying migration");
    await pool.query(sql);
  }

  log.info({ count: files.length }, "migrations applied");
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "migration failed");
  process.exit(1);
});
