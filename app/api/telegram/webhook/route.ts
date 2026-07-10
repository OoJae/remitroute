// Telegram bot webhook. Handles exactly two commands: /start <code> binds the
// sending chat to the RemitRoute user whose signed link code this is, and
// /stop unlinks it. Authenticated by Telegram's secret token header (set at
// setWebhook time), which middleware lets through as a public path; without a
// configured secret the route refuses to exist. Always answers 200 so Telegram
// does not retry garbage forever.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { verifyLinkCode } from "../../../../shared/telegramLink.js";
import { sendTelegram } from "../../../../shared/receipts.js";
import { log } from "../../../../shared/log.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TgUpdate {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
}

export async function POST(request: Request) {
  if (!config.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== config.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = (await request.json().catch(() => null)) as TgUpdate | null;
  const text = update?.message?.text?.trim();
  const chatIdRaw = update?.message?.chat?.id;
  if (!text || chatIdRaw === undefined || chatIdRaw === null) {
    return NextResponse.json({ ok: true });
  }
  const chatId = String(chatIdRaw);

  try {
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1] ?? "";
      const userId = verifyLinkCode(code);
      if (!userId) {
        await sendTelegram(
          chatId,
          "That link has expired. Open the RemitRoute Mini App and tap Connect Telegram again.",
        );
        return NextResponse.json({ ok: true });
      }
      // One chat maps to one user: release the chat from any previous account
      // before binding (telegram_id is unique).
      await db.update(users).set({ telegramId: null }).where(eq(users.telegramId, chatId));
      const updated = await db
        .update(users)
        .set({ telegramId: chatId })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated.length > 0) {
        log.info({ userId }, "telegram chat linked");
        await sendTelegram(
          chatId,
          "Connected. You will get a receipt here every time your RemitRoute agent moves money, with the transaction link and proof hash. Send /stop to unlink.",
        );
      }
    } else if (text.startsWith("/stop")) {
      await db.update(users).set({ telegramId: null }).where(eq(users.telegramId, chatId));
      await sendTelegram(chatId, "Unlinked. You will no longer receive receipts here.");
    }
  } catch (err) {
    log.warn({ err }, "telegram webhook handling failed");
  }
  return NextResponse.json({ ok: true });
}
