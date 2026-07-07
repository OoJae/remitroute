import { describe, it, expect } from "vitest";
import { classifyMove, buyBudgetUsd } from "../shared/moveStatus.js";

describe("classifyMove", () => {
  it("confirmed/success/dry_run -> ok", () => {
    for (const s of ["confirmed", "success", "dry_run"]) expect(classifyMove(s)).toBe("ok");
  });
  it("broadcast_unknown -> unknown (never a failure, never retried, no double-swap)", () => {
    expect(classifyMove("broadcast_unknown")).toBe("unknown");
  });
  it("reverted -> reverted (not retried)", () => {
    expect(classifyMove("reverted")).toBe("reverted");
  });
  it("every skipped_* -> skipped", () => {
    for (const s of ["skipped_cap", "skipped_dust", "skipped_empty", "skipped_duplicate"]) {
      expect(classifyMove(s)).toBe("skipped");
    }
  });
  it("a never-broadcast failure -> failed", () => {
    expect(classifyMove("failed")).toBe("failed");
  });
});

describe("buyBudgetUsd", () => {
  it("is the cUSD available above its own target, floored at zero", () => {
    expect(buyBudgetUsd(10, 4)).toBe(6);
  });
  it("is zero when sells produced nothing (cUSD at or below its target)", () => {
    expect(buyBudgetUsd(4, 4)).toBe(0);
    expect(buyBudgetUsd(2, 4)).toBe(0);
  });
});
