import { describe, it, expect } from "vitest";
import { apyFromRay, netContributed, earnedApprox } from "../shared/yieldMath.js";

describe("apyFromRay", () => {
  it("converts a 5% ray APR to a slightly higher per-second-compounded APY", () => {
    const fivePctRay = 5n * 10n ** 25n; // 0.05 * 1e27
    const apy = apyFromRay(fivePctRay);
    expect(apy).toBeGreaterThan(5.0);
    expect(apy).toBeLessThan(5.2); // e^0.05 - 1 = 5.127%
  });
  it("returns 0 for a zero or negative rate", () => {
    expect(apyFromRay(0n)).toBe(0);
  });
});

describe("netContributed", () => {
  it("sums confirmed supplies and subtracts sized withdrawals", () => {
    expect(
      netContributed([
        { kind: "savings_sweep", status: "confirmed", amountIn: "1.0" },
        { kind: "savings_sweep", status: "confirmed", amountIn: "0.5" },
        { kind: "yield_withdraw", status: "confirmed", amountIn: "0.3" },
      ]),
    ).toBeCloseTo(1.2);
  });
  it("ignores rows that never moved money (skips, dry runs, failures)", () => {
    expect(
      netContributed([
        { kind: "savings_sweep", status: "skipped_cap", amountIn: "9" },
        { kind: "savings_sweep", status: "dry_run", amountIn: "9" },
        { kind: "savings_sweep", status: "failed", amountIn: "9" },
        { kind: "savings_sweep", status: "confirmed", amountIn: "1" },
      ]),
    ).toBe(1);
  });
  it("a max withdrawal (null amount) empties the position and resets the baseline", () => {
    expect(
      netContributed([
        { kind: "savings_sweep", status: "confirmed", amountIn: "5" },
        { kind: "yield_withdraw", status: "confirmed", amountIn: null },
        { kind: "savings_sweep", status: "confirmed", amountIn: "2" },
      ]),
    ).toBe(2);
  });
  it("never goes negative on an oversized withdrawal", () => {
    expect(
      netContributed([
        { kind: "savings_sweep", status: "confirmed", amountIn: "1" },
        { kind: "yield_withdraw", status: "confirmed", amountIn: "5" },
      ]),
    ).toBe(0);
  });
});

describe("earnedApprox", () => {
  it("is the supplied balance above net contributions, floored at zero", () => {
    expect(earnedApprox(1.25, 1.2)).toBeCloseTo(0.05);
    expect(earnedApprox(1.0, 1.2)).toBe(0);
  });
});
