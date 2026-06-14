// Drizzle client over a node-postgres pool. Shared by the agent scripts and the
// Next.js app. One DATABASE_URL (Neon) backs both.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // Neon requires TLS. node-postgres honors sslmode in the URL, but set this so
  // self-signed chains in hosted Postgres do not break the connection.
  ssl: config.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });
export { pool, schema };
