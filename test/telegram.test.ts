import { describe, it, expect } from "vitest";
import { makeLinkCode, verifyLinkCode } from "../shared/telegramLink.js";
import { receiptWorthy, formatReceipt } from "../shared/receipts.js";

const USER = "11111111-2222-3333-4444-555555555555";

describe("telegram link codes", () => {
  it("round-trips a userId within the ttl", () => {
    const code = makeLinkCode(USER);
    expect(code).toMatch(/^[0-9a-f]{60}$/);
    expect(verifyLinkCode(code)).toBe(USER);
  });
  it("rejects an expired code", () => {
    const code = makeLinkCode(USER, Date.now() - 16 * 60 * 1000);
    expect(verifyLinkCode(code)).toBeNull();
  });
  it("rejects tampering with any field", () => {
    const code = makeLinkCode(USER);
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "0" ? "1" : "0") + s.slice(i + 1);
    expect(verifyLinkCode(flip(code, 3))).toBeNull(); // userId
    expect(verifyLinkCode(flip(code, 35))).toBeNull(); // expiry
    expect(verifyLinkCode(flip(code, 45))).toBeNull(); // signature
    expect(verifyLinkCode("garbage")).toBeNull();
  });
});

describe("receiptWorthy", () => {
  it("sends for money-moved and protective-skip states", () => {
    for (const s of ["confirmed", "reverted", "broadcast_unknown", "skipped_cap", "skipped_no_recipient", "skipped_locked"]) {
      expect(receiptWorthy(s)).toBe(true);
    }
  });
  it("stays silent for retries, dry runs, and non-news skips", () => {
    for (const s of ["failed", "dry_run", "pending", "skipped_duplicate", "skipped_dust", "skipped_empty"]) {
      expect(receiptWorthy(s)).toBe(false);
    }
  });
});

describe("formatReceipt", () => {
  const TXHASH = "0x" + "ab".repeat(32);
  const base = {
    id: "e1",
    userId: USER,
    kind: "remittance",
    status: "confirmed",
    amountIn: "0.300000",
    tokenIn: "cUSD",
    txHash: TXHASH,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  it("includes the action, the celoscan link, and a proof hash", () => {
    const msg = formatReceipt(base);
    expect(msg).toContain("Sent 0.3 cUSD");
    expect(msg).toContain(`celoscan.io/tx/${TXHASH}`);
    expect(msg).toContain("proof <code>0x");
  });
  it("omits the link for a malformed hash instead of dropping the receipt", () => {
    const msg = formatReceipt({ ...base, txHash: "0xabc" });
    expect(msg).toContain("Sent 0.3 cUSD");
    expect(msg).not.toContain("celoscan.io");
  });
  it("explains protective skips in plain language", () => {
    const msg = formatReceipt({ ...base, status: "skipped_cap", txHash: null });
    expect(msg).toContain("daily spend cap");
    expect(msg).not.toContain("celoscan.io");
  });
  it("escapes HTML in token fields", () => {
    const msg = formatReceipt({ ...base, tokenIn: "<b>x" });
    expect(msg).not.toContain("<b>x");
    expect(msg).toContain("&lt;b&gt;x");
  });
});
