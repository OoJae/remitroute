// Edge auth gate. Runs before every /api route (and /mcp). It (1) strips any
// client-supplied identity headers so they cannot be spoofed, and (2) for
// non-public routes, verifies the session cookie and injects a trusted
// x-user-id / x-user-address for the handler. Imports only shared/session.ts,
// which is pure Web Crypto (no pg, no node:crypto, no dotenv) and Edge-safe.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./shared/session.js";

// Routes that do not require a session.
const PUBLIC_PATTERNS: RegExp[] = [
  /^\/api\/auth\//,
  /^\/api\/dashboard(\/|$)/,
  /^\/api\/agent-info(\/|$)/,
  /^\/api\/well-known-agent(\/|$)/,
  /^\/api\/fx-route(\/|$)/,
  /^\/api\/healthz(\/|$)/,
  /^\/api\/readyz(\/|$)/,
  // Authenticated by Telegram's secret token header inside the handler, not by
  // a user session (Telegram's servers are the caller).
  /^\/api\/telegram\/webhook(\/|$)/,
  /^\/mcp(\/|$)/,
];

function isPublic(path: string): boolean {
  return PUBLIC_PATTERNS.some((re) => re.test(path));
}

export async function middleware(request: NextRequest) {
  // Never let a caller assert their own identity.
  const headers = new Headers(request.headers);
  headers.delete("x-user-id");
  headers.delete("x-user-address");

  const path = request.nextUrl.pathname;
  if (isPublic(path)) {
    return NextResponse.next({ request: { headers } });
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET;
  const session = token && secret ? await verifySession(token, secret) : null;
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  headers.set("x-user-id", session.userId);
  headers.set("x-user-address", session.addr);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/:path*", "/mcp/:path*", "/mcp"],
};
