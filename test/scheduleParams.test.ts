import { describe, it, expect } from "vitest";
import { validateParams } from "../shared/scheduleParams.js";

const VALID_ADDR = "0x000000000000000000000000000000000000dEaD";

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
