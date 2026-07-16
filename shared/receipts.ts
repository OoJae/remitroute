// Per-action user receipts. Whenever a money action reaches a state the user
// would want to know about, send a Telegram message to their linked chat: what
// moved, why the agent acted (or refused to), the Celoscan link, and the same
// proof hash the public dashboard stamps. This is the agent reporting to its
// owner. Fire-and-forget discipline: every failure is swallowed and logged, a
// receipt can never break a money path, and the whole module is a no-op until
// TELEGRAM_BOT_TOKEN is set and the user has linked a chat.
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { users } from "./db/schema.js";
import { config } from "./config.js";
import { executionProofHash } from "./proof.js";
import { log } from "./log.js";

// Statuses worth interrupting the user for. Deliberately excluded: "failed"
// (transient, run-due retries it next heartbeat), "dry_run", "skipped_duplicate"
// (idempotency doing its job silently), and "skipped_dust"/"skipped_empty"
// (nothing to do is not news).
const RECEIPT_STATUSES = new Set([
  "confirmed",
  "reverted",
  "broadcast_unknown",
  "skipped_cap",
  "skipped_no_recipient",
  "skipped_locked",
]);

export function receiptWorthy(status: string): boolean {
  return RECEIPT_STATUSES.has(status);
}

export interface ReceiptRow {
  id: string;
  userId: string | null;
  kind: string;
  status: string;
  txHash?: string | null;
  amountIn?: string | null;
  tokenIn?: string | null;
  amountOut?: string | null;
  tokenOut?: string | null;
  error?: string | null;
  // Why the agent took this action, captured at decision time.
  rationale?: string | null;
  createdAt?: Date | string | null;
}

function trim(amount: string | null | undefined): string {
  if (!amount) return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// One human line for what the action was, by kind.
function actionPhrase(row: ReceiptRow): string {
  const amt = trim(row.amountIn);
  const tokenIn = row.tokenIn ?? "";
  switch (row.kind) {
    case "remittance":
    case "bill_drip":
      return `Sent ${amt} ${tokenIn}`;
    case "dca":
    case "fx_rebalance": {
      const out = row.amountOut ? `${trim(row.amountOut)} ${row.tokenOut ?? ""}` : row.tokenOut ?? "";
      return `Swapped ${amt} ${tokenIn}${out ? ` to ${out}` : ""}`;
    }
    case "savings_sweep":
      return `Saved ${amt} ${tokenIn} into Aave`;
    case "yield_withdraw":
      return amt ? `Withdrew ${amt} ${tokenIn} from savings` : `Withdrew all ${tokenIn} from savings`;
    case "user_withdraw":
      return `Withdrew ${amt} ${tokenIn} to your MiniPay`;
    default:
      return `${row.kind} ${amt} ${tokenIn}`.trim();
  }
}

function headline(row: ReceiptRow): string {
  const action = esc(actionPhrase(row));
  switch (row.status) {
    case "confirmed":
      return `✅ <b>${action}</b>`;
    case "reverted":
      return `⛔ <b>${action}</b> reverted on-chain; no funds moved`;
    case "broadcast_unknown":
      return `⏳ <b>${action}</b> submitted; confirmation pending. The agent will not resubmit.`;
    case "skipped_cap":
      return `\u{1F6D1} Skipped <b>${action}</b>: it would break your daily spend cap`;
    case "skipped_no_recipient":
      return `\u{1F6D1} Skipped <b>${action}</b>: the recipient is not on your allowlist`;
    case "skipped_locked":
      return `\u{1F512} Skipped <b>${action}</b>: those savings are locked by a goal`;
    default:
      return `<b>${action}</b> ${esc(row.status)}`;
  }
}

export function formatReceipt(row: ReceiptRow): string {
  const lines = [headline(row)];
  // Only link a well-formed hash. If a corrupt value ever reached txHash, an
  // unescaped interpolation would make Telegram reject the whole message (HTTP
  // 400) and the receipt would be silently dropped; degrade to linkless instead.
  if (row.txHash && /^0x[0-9a-fA-F]{64}$/.test(row.txHash)) {
    lines.push(`<a href="https://celoscan.io/tx/${row.txHash}">View on Celoscan</a>`);
  }
  const proof = executionProofHash({
    id: row.id,
    kind: row.kind,
    status: row.status,
    amountIn: row.amountIn ?? null,
    tokenIn: row.tokenIn ?? null,
    amountOut: row.amountOut ?? null,
    tokenOut: row.tokenOut ?? null,
    txHash: row.txHash ?? null,
    createdAt: row.createdAt ?? null,
  });
  if (row.rationale) lines.push(`<i>why: ${row.rationale}</i>`);
  lines.push(`proof <code>${proof.slice(0, 18)}…</code>`);
  return lines.join("\n");
}

export async function sendTelegram(chatId: string, html: string): Promise<boolean> {
  if (!config.TELEGRAM_BOT_TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}

// Non-blocking receipt dispatch. The ledger layers call queueReceipt (they do
// NOT await it) so a slow or partitioned Telegram cannot serialize up to 5s per
// action into the sequential heartbeat money loop. The in-flight promises are
// tracked so a long-lived process (run-due) or a serverless route can drain
// them with flushReceipts() before it exits and drops them.
const pendingReceipts: Promise<void>[] = [];

export function queueReceipt(row: ReceiptRow | undefined): void {
  pendingReceipts.push(emitReceipt(row));
}

export async function flushReceipts(): Promise<void> {
  const inflight = pendingReceipts.splice(0);
  if (inflight.length > 0) await Promise.allSettled(inflight);
}

// The actual delivery. Guaranteed never to throw.
export async function emitReceipt(row: ReceiptRow | undefined): Promise<void> {
  try {
    if (!row || !config.TELEGRAM_BOT_TOKEN) return;
    if (!row.userId || !receiptWorthy(row.status)) return;
    const [user] = await db
      .select({ telegramId: users.telegramId })
      .from(users)
      .where(eq(users.id, row.userId));
    if (!user?.telegramId) return;
    const ok = await sendTelegram(user.telegramId, formatReceipt(row));
    if (!ok) log.warn({ executionId: row.id }, "receipt delivery not ok");
  } catch (err) {
    log.warn({ err, executionId: row?.id }, "receipt delivery failed (ignored)");
  }
}
