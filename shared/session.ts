// Edge-safe signed session tokens. HMAC-SHA256 via Web Crypto only: no
// node:crypto, no pg, no config/dotenv imports, so this module runs unchanged in
// Next.js middleware (Edge runtime) and in Node route handlers. The secret is
// passed in by the caller (config.SESSION_SECRET on the server, process.env in
// middleware) so this file never reads the environment itself.

export const SESSION_COOKIE = "rr_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

export interface Session {
  userId: string;
  addr: string; // lowercased MiniPay address the session is bound to
  exp: number; // unix seconds
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// payloadB64.signatureB64 (compact, JWT-like but minimal).
export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = bytesToB64url(encoder.encode(JSON.stringify(session)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${bytesToB64url(sig)}`;
}

// Returns the session only if the HMAC verifies (constant-time via subtle.verify)
// and it has not expired. Any tampering or missing/expired token returns null.
export async function verifySession(token: string, secret: string): Promise<Session | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlToBytes(sig);
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as unknown as BufferSource,
    encoder.encode(payload) as unknown as BufferSource,
  );
  if (!ok) return null;
  try {
    const session = JSON.parse(decoder.decode(b64urlToBytes(payload))) as Session;
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
    if (!session.userId || !session.addr) return null;
    return session;
  } catch {
    return null;
  }
}
