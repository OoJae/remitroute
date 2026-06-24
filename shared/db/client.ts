// Drizzle client over a node-postgres pool. Shared by the agent scripts and the
// Next.js app. One DATABASE_URL (Neon) backs both.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // Verify the server certificate (Neon serves a public CA chain Node trusts).
  // Never disable verification: an on-path attacker could otherwise MITM Postgres
  // and read encrypted-key ciphertext / inject results. Plain TLS off only for a
  // local dev database.
  ssl: config.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: true },
});

export const db = drizzle(pool, { schema });
export { pool, schema };
