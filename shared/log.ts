// Structured logging plus an optional Langfuse trace wrapper. If Langfuse keys
// are absent, tracing is a no-op so local runs need no extra setup.
import pino from "pino";
import { config } from "./config.js";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "remitroute" },
});

type TraceFields = Record<string, unknown>;

// Wrap an async unit of work with a trace. Logs start, success, and failure.
// Langfuse is loaded lazily and only when configured, to keep scripts light.
export async function trace<T>(
  name: string,
  fields: TraceFields,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  log.info({ trace: name, ...fields }, `${name} start`);
  try {
    const result = await fn();
    log.info({ trace: name, ms: Date.now() - start }, `${name} ok`);
    await maybeLangfuse(name, fields, "ok", Date.now() - start);
    return result;
  } catch (err) {
    log.error({ trace: name, err, ms: Date.now() - start }, `${name} failed`);
    await maybeLangfuse(name, fields, "error", Date.now() - start);
    throw err;
  }
}

async function maybeLangfuse(
  name: string,
  fields: TraceFields,
  status: "ok" | "error",
  ms: number,
): Promise<void> {
  if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) return;
  try {
    const { Langfuse } = await import("langfuse");
    const lf = new Langfuse({
      publicKey: config.LANGFUSE_PUBLIC_KEY,
      secretKey: config.LANGFUSE_SECRET_KEY,
      baseUrl: config.LANGFUSE_BASEURL,
    });
    lf.trace({ name, metadata: { ...fields, status, ms } });
    await lf.flushAsync();
  } catch {
    // Tracing must never break a real action. Swallow trace errors.
  }
}
