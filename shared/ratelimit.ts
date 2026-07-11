// DB-backed fixed-window rate limiter. Works across many serverless instances
// (an in-memory Map would not on Vercel). Fail-open: if the limiter errors, the
// request is allowed, so a DB hiccup never locks users out.
import { sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { config } from "./config.js";
import { log } from "./log.js";

export async function rateLimit(
  key: string,
  opts?: { max?: number; windowSec?: number; failClosed?: boolean },
): Promise<{ allowed: boolean; remaining: number }> {
  const max = opts?.max ?? config.RATE_LIMIT_MAX;
  const windowSec = opts?.windowSec ?? config.RATE_LIMIT_WINDOW_SEC;
  try {
    const result = await db.execute(sql`
      insert into rate_limits (key, count, window_start)
      values (${key}, 1, now())
      on conflict (key) do update set
        count = case
          when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then 1
          else rate_limits.count + 1 end,
        window_start = case
          when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then now()
          else rate_limits.window_start end
      returning count
    `);
    const rows = (result as unknown as { rows?: Array<{ count: number }> }).rows ?? [];
    const count = Number(rows[0]?.count ?? 0);
    return { allowed: count <= max, remaining: Math.max(0, max - count) };
  } catch (err) {
    // Default fail-open (a DB hiccup must not lock users out). Routes that gate
    // real spend pass failClosed so an outage cannot become an amplifier.
    const allowed = !opts?.failClosed;
    log.warn({ err, key, failClosed: Boolean(opts?.failClosed) }, `rate limiter errored; failing ${allowed ? "open" : "closed"}`);
    return { allowed, remaining: allowed ? max : 0 };
  }
}

// Best-effort client IP for keying limits (Vercel sets x-forwarded-for).
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
