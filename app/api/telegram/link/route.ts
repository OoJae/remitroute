// Start the Telegram link flow: mint a signed, short-lived code and hand back
// the t.me deep link. Binding happens when the bot's webhook receives
// /start <code> from the user's own Telegram account, so the chat id never
// passes through the client.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { makeLinkCode } from "../../../../shared/telegramLink.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!config.TELEGRAM_BOT_USERNAME) {
    return NextResponse.json({ error: "telegram receipts are not configured" }, { status: 503 });
  }

  const [user] = await db
    .select({ telegramId: users.telegramId })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  const code = makeLinkCode(userId);
  return NextResponse.json({
    linked: Boolean(user.telegramId),
    deepLink: `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${code}`,
  });
}
