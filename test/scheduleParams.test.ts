import { describe, it, expect } from "vitest";
import {
  validateParams,
  validateDraftParams,
  normalizeSendToken,
} from "../shared/scheduleParams.js";

const VALID_ADDR = "0x000000000000000000000000000000000000dEaD";

describe("normalizeSendToken", () => {
  it("maps MiniPay-era and plain-English aliases to cUSD", () => {
    for (const raw of ["musd", "mUSD", "USDm", "usd", "dollars", "$"]) {
      expect(normalizeSendToken(raw)).toBe("cUSD");
    }
  });

  it("canonicalizes casing for real symbols", () => {
    expect(normalizeSendToken("celo")).toBe("CELO");
    expect(normalizeSendToken("cusd")).toBe("cUSD");
    expect(normalizeSendToken("CUSD")).toBe("cUSD");
  });

  it("does not swallow usdc or usdt with the usd alias", () => {
    expect(normalizeSendToken("usdc")).toBe("USDC");
    expect(normalizeSendToken("usdt")).toBe("USDT");
  });

  it("trims whitespace", () => {
    expect(normalizeSendToken("  cUSD  ")).toBe("cUSD");
  });

  it("returns unknown input unchanged", () => {
    expect(normalizeSendToken("cNGN")).toBe("cNGN");
  });
});

describe("validateParams: remittance (TransferParams)", () => {
  it("rejects a non-address `to`", () => {
    expect(() =>
      validateParams("remittance", { to: "not-an-address", amount: "10" }),
    ).toThrow();
  });

  it("accepts a valid 0x address and defaults the token", () => {
    const out = validateParams("remittance", { to: VALID_ADDR, amount: "10" });
    expect(out.to).toBe(VALID_ADDR);
    expect(out.amount).toBe("10");
    expect(out.token).toBe("cUSD");
  });

  it("rejects a non-positive amount", () => {
    expect(() =>
      validateParams("remittance", { to: VALID_ADDR, amount: "0" }),
    ).toThrow();
  });

  it("normalizes an aliased token at save time", () => {
    const out = validateParams("remittance", { to: VALID_ADDR, amount: "10", token: "musd" });
    expect(out.token).toBe("cUSD");
  });

  it("rejects a swap-only token with a clear message", () => {
    expect(() =>
      validateParams("remittance", { to: VALID_ADDR, amount: "10", token: "cNGN" }),
    ).toThrow(/cannot be sent/);
  });

  it("applies the same token gate to bill_drip", () => {
    const out = validateParams("bill_drip", { to: VALID_ADDR, amount: "10", token: "USDm" });
    expect(out.token).toBe("cUSD");
    expect(() =>
      validateParams("bill_drip", { to: VALID_ADDR, amount: "10", token: "cKES" }),
    ).toThrow(/cannot be sent/);
  });
});

describe("validateDraftParams: parse-time transfer drafts", () => {
  it("accepts a phone-number recipient and normalizes the token (the pilot shape)", () => {
    const out = validateDraftParams("remittance", {
      to: "+2348154614229",
      amount: "28",
      token: "musd",
    });
    expect(out.to).toBe("+2348154614229");
    expect(out.amount).toBe("28");
    expect(out.token).toBe("cUSD");
  });

  it("accepts a valid 0x recipient too", () => {
    const out = validateDraftParams("remittance", { to: VALID_ADDR, amount: "28" });
    expect(out.to).toBe(VALID_ADDR);
    expect(out.token).toBe("cUSD");
  });

  it("still rejects an empty recipient and a non-positive amount", () => {
    expect(() => validateDraftParams("remittance", { to: "", amount: "28" })).toThrow();
    expect(() =>
      validateDraftParams("remittance", { to: "+2348154614229", amount: "0" }),
    ).toThrow();
  });

  it("still gates the token allowlist in drafts", () => {
    expect(() =>
      validateDraftParams("bill_drip", { to: "mom", amount: "5", token: "cZAR" }),
    ).toThrow(/cannot be sent/);
  });

  it("delegates non-transfer kinds to the strict schema unchanged", () => {
    const out = validateDraftParams("dca", { tokenOut: "cKES", amount: "5" });
    expect(out.tokenOut).toBe("cKES");
    expect(out.tokenIn).toBe("cUSD");
    expect(() => validateDraftParams("dca", { amount: "5" })).toThrow();
  });
});

describe("validateParams: dca (DcaParams)", () => {
  it("accepts a minimal valid shape and defaults tokenIn", () => {
    const out = validateParams("dca", { tokenOut: "CELO", amount: "5" });
    expect(out.tokenIn).toBe("cUSD");
    expect(out.tokenOut).toBe("CELO");
    expect(out.amount).toBe("5");
  });

  it("rejects a missing tokenOut", () => {
    expect(() => validateParams("dca", { amount: "5" })).toThrow();
  });

  it("rejects slippageBps outside the allowed band", () => {
    expect(() =>
      validateParams("dca", { tokenOut: "CELO", amount: "5", slippageBps: 9999 }),
    ).toThrow();
  });
});
