// Operator alerting. notify() posts a message to ALERT_WEBHOOK_URL (Slack /
// Telegram / generic JSON webhook). Best-effort: a delivery failure is logged but
// never breaks the caller. pingDeadman() hits DEADMAN_PING_URL once per healthy
// heartbeat so an external watchdog (e.g. healthchecks.io) can detect a stalled
// engine. Replaces the audit's "alert the operator" log lines that paged nobody.
import { config } from "./config.js";
import { log } from "./log.js";

export async function notify(message: string, context?: Record<string, unknown>): Promise<void> {
  log.warn({ alert: message, ...context }, "operator alert");
  const url = config.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` suits Slack/Telegram-bridge webhooks; `message`/`context` suit generic sinks.
      body: JSON.stringify({ text: `RemitRoute: ${message}`, message, context: context ?? {} }),
    });
  } catch (err) {
    log.error({ err }, "failed to deliver operator alert");
  }
}

export async function pingDeadman(): Promise<void> {
  const url = config.DEADMAN_PING_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "GET" });
  } catch (err) {
    log.warn({ err }, "dead-man ping failed");
  }
}
