import { describe, it, expect } from "vitest";
import { signSession, verifySession, SESSION_TTL_SECONDS } from "../shared/session.js";
import type { Session } from "../shared/session.js";

const SECRET = "test-session-secret-0000000000000000000000000000000000000000";

function freshSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-123",
    addr: "0x000000000000000000000000000000000000dead",
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    ...overrides,
  };
}

describe("signSession / verifySession", () => {
  it("round-trips a valid session with the right secret", async () => {
    const session = freshSession();
    const token = await signSession(session, SECRET);
    const out = await verifySession(token, SECRET);
    expect(out).toEqual(session);
  });

  it("returns null for a tampered token", async () => {
    const token = await signSession(freshSession(), SECRET);
    // Flip a character in the payload portion (before the dot).
    const dot = token.indexOf(".");
    const flipped =
      (token[0] === "a" ? "b" : "a") + token.slice(1, dot) + token.slice(dot);
    expect(await verifySession(flipped, SECRET)).toBeNull();
  });

  it("returns null when verified with the wrong secret", async () => {
    const token = await signSession(freshSession(), SECRET);
    expect(await verifySession(token, "a-completely-different-secret")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const expired = freshSession({ exp: Math.floor(Date.now() / 1000) - 60 });
    const token = await signSession(expired, SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("returns null for a structurally invalid token", async () => {
    expect(await verifySession("not-a-token", SECRET)).toBeNull();
  });
});
