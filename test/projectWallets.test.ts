// Keep the machine-readable wallet list and the human-readable declaration in
// step. WALLETS.md is what a judge reads; shared/projectWallets.ts is what the
// send path checks against. If they drift, either the UI stops refusing a
// transfer to one of our own wallets, or we publish a declaration that does not
// match what the code believes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PROJECT_WALLETS, isProjectWallet } from "../shared/projectWallets.js";

const declared = readFileSync(new URL("../WALLETS.md", import.meta.url), "utf8");
const inDoc = new Set((declared.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));

describe("project wallet list", () => {
  it("declares every wallet the code knows about", () => {
    for (const a of PROJECT_WALLETS) {
      expect(inDoc.has(a.toLowerCase()), `${a} is guarded in code but missing from WALLETS.md`).toBe(true);
    }
  });

  it("guards every wallet the declaration lists", () => {
    const inCode = new Set(PROJECT_WALLETS.map((a) => a.toLowerCase()));
    for (const a of inDoc) {
      expect(inCode.has(a), `${a} is declared in WALLETS.md but not guarded in code`).toBe(true);
    }
  });

  it("holds the 3 operating plus 23 custodial wallets, with no duplicates", () => {
    expect(PROJECT_WALLETS).toHaveLength(26);
    expect(new Set(PROJECT_WALLETS.map((a) => a.toLowerCase())).size).toBe(26);
  });

  it("matches regardless of casing or surrounding whitespace", () => {
    const sample = PROJECT_WALLETS[0]!;
    expect(isProjectWallet(sample)).toBe(true);
    expect(isProjectWallet(sample.toLowerCase())).toBe(true);
    expect(isProjectWallet(sample.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isProjectWallet(`  ${sample}  `)).toBe(true);
  });

  it("does not claim wallets that are not ours", () => {
    // A family member's wallet must stay sendable.
    expect(isProjectWallet("0xc3E3B365fB4a2148c6C2FA97A73B42d57de75f5C")).toBe(false);
    expect(isProjectWallet("0x0000000000000000000000000000000000000000")).toBe(false);
  });
});
