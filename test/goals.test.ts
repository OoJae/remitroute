import { describe, it, expect } from "vitest";
import { lockBreached, goalLockedUsd } from "../shared/goalMath.js";

describe("goalLockedUsd", () => {
  it("locks the accumulated amount up to the target, floored at zero", () => {
    expect(goalLockedUsd(3, 10)).toBe(3); // under target: lock what is saved
    expect(goalLockedUsd(12, 10)).toBe(10); // over target: lock only the target
    expect(goalLockedUsd(0, 10)).toBe(0);
    expect(goalLockedUsd(-1, 10)).toBe(0);
  });
});

describe("lockBreached", () => {
  it("blocks a withdrawal that dips below the locked floor", () => {
    // position 1.0, locked 0.5 -> at most 0.5 withdrawable
    expect(lockBreached(0.6, 1.0, 0.5)).toBe(true);
    expect(lockBreached(0.5, 1.0, 0.5)).toBe(false);
    expect(lockBreached(0.4, 1.0, 0.5)).toBe(false);
  });
  it("blocks a full-position withdraw when anything is locked", () => {
    expect(lockBreached(1.0, 1.0, 0.5)).toBe(true);
    expect(lockBreached(1.0, 1.0, 0.05)).toBe(true);
  });
  it("allows a full-position withdraw when nothing is locked (no float false-positive)", () => {
    expect(lockBreached(1.0, 1.0, 0)).toBe(false);
    expect(lockBreached(0.15000013, 0.15000013, 0)).toBe(false);
  });
  it("a regression that reports zero locked disables the gate (pins the failure vector)", () => {
    // If lockedUsdFor ever returns 0 (e.g. an asset-casing mismatch so goals
    // never match), every withdrawal is allowed - this is exactly the silent
    // failure the guardrail test must catch.
    expect(lockBreached(1.0, 1.0, 0)).toBe(false);
  });
});
