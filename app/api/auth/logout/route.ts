// Clear the session cookie.
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../shared/session.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
