import { describe, it, expect } from "vitest";
import { isValidCadence, computeNextRun } from "../shared/cadence.js";

describe("isValidCadence", () => {
  it("accepts the supported simple and parameterized forms", () => {
    for (const c of [
      "once",
      "daily",
      "weekly",
      "weekly:fri",
      "monthly:1",
      "monthly:28",
      "every:20m",
      "every:2h",
      "  DAILY  ", // trimmed + lowercased
    ]) {
      expect(isValidCadence(c), c).toBe(true);
    }
  });

  it("rejects malformed or out-of-range strings", () => {
    for (const c of [
      "",
      "hourly",
      "weekly:funday",
      "monthly:0",
      "monthly:29",
      "monthly:abc",
      "every:0m",
      "every:5d",
      "every:m",
      "nonsense",
    ]) {
      expect(isValidCadence(c), c).toBe(false);
    }
  });
});

describe("computeNextRun", () => {
  const from = new Date("2026-06-10T08:30:00.000Z"); // a Wednesday

  it("returns null for the once cadence", () => {
    expect(computeNextRun("once", from)).toBeNull();
  });

  it("advances daily by exactly 24 hours", () => {
    const next = computeNextRun("daily", from);
    expect(next).not.toBeNull();
    expect(next!.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("advances every:20m by exactly 20 minutes", () => {
    const next = computeNextRun("every:20m", from);
    expect(next!.getTime() - from.getTime()).toBe(20 * 60 * 1000);
  });

  it("advances every:2h by exactly 2 hours", () => {
    const next = computeNextRun("every:2h", from);
    expect(next!.getTime() - from.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it("monthly:1 lands on day 1 of the month, strictly after `from`", () => {
    const next = computeNextRun("monthly:1", from);
    expect(next).not.toBeNull();
    expect(next!.getUTCDate()).toBe(1);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
    // from is June 10, so the next day-1 is July 1.
    expect(next!.getUTCMonth()).toBe(6); // July (0-indexed)
  });
});
