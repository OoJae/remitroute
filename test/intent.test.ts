import { describe, it, expect } from "vitest";
import { computeIntentId, deriveIntentId, canonicalJson } from "../shared/intent.js";

const base = {
  scheduleId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  kind: "remittance",
  params: { to: "0xabc", amount: "1", token: "cUSD" },
  dueSlot: "2026-07-07T00:00:00.000Z",
};

describe("computeIntentId", () => {
  it("is deterministic and stable across a reclaim re-run (same inputs -> same id)", () => {
    expect(computeIntentId(base)).toBe(computeIntentId({ ...base }));
  });
  it("is independent of params key order", () => {
    const reordered = { ...base, params: { token: "cUSD", amount: "1", to: "0xabc" } };
    expect(computeIntentId(reordered)).toBe(computeIntentId(base));
  });
  it("changes with the due slot (a real next cadence slot is a distinct intent)", () => {
    expect(computeIntentId({ ...base, dueSlot: "2026-07-08T00:00:00.000Z" })).not.toBe(computeIntentId(base));
  });
  it("changes with a suffix (rebalance legs / pre-withdraw are distinct)", () => {
    expect(computeIntentId({ ...base, suffix: "prewithdraw" })).not.toBe(computeIntentId(base));
  });
  it("produces a 64-char hex sha256", () => {
    expect(computeIntentId(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveIntentId", () => {
  it("distinct suffixes yield distinct ids (rebalance legs do not collide)", () => {
    const b = computeIntentId(base);
    expect(deriveIntentId(b, "cKES>cUSD")).not.toBe(deriveIntentId(b, "cUSD>cKES"));
  });
  it("is deterministic", () => {
    const b = computeIntentId(base);
    expect(deriveIntentId(b, "x")).toBe(deriveIntentId(b, "x"));
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively so equal params serialize identically", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
