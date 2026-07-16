import { describe, it, expect } from "vitest";
import { computeDriftBps, updateMovingAverage, pickRebalanceLeg, type BasketLeg } from "../shared/basket.js";

// The basket agent trades real money off these numbers, so the drift arithmetic,
// the hub-budget guard and the signal tilt are pinned here rather than trusted.

describe("computeDriftBps", () => {
  it("is positive when a leg is over target and negative when under", () => {
    expect(computeDriftBps(0.25, 0.2)).toBeCloseTo(500);
    expect(computeDriftBps(0.15, 0.2)).toBeCloseTo(-500);
    expect(computeDriftBps(0.2, 0.2)).toBeCloseTo(0);
  });
});

describe("updateMovingAverage", () => {
  it("reports no deviation until there is history to compare against", () => {
    const { ring, deviationBps } = updateMovingAverage([], 1, 20);
    expect(ring).toEqual([1]);
    expect(deviationBps).toBe(0);
  });
  it("trims to the window and measures the latest price against the mean", () => {
    let ring: number[] = [];
    for (const p of [1, 1, 1, 1]) ring = updateMovingAverage(ring, p, 3).ring;
    expect(ring).toHaveLength(3);
    // Latest price 10% above a flat history reads as a positive deviation.
    const { ma, deviationBps } = updateMovingAverage([1, 1, 1], 1.1, 4);
    expect(ma).toBeCloseTo(1.025);
    expect(deviationBps).toBeGreaterThan(0);
  });
});

describe("pickRebalanceLeg", () => {
  const legs = (): BasketLeg[] => [
    { symbol: "cUSD", valueUsd: 50, target: 0.5 },
    { symbol: "USDT", valueUsd: 30, target: 0.2 }, // over target -> sell candidate
    { symbol: "cKES", valueUsd: 20, target: 0.3 }, // under target -> buy candidate
  ];

  it("returns null when the basket is empty", () => {
    expect(pickRebalanceLeg([], 10)).toBeNull();
  });

  it("returns null while every leg is inside the drift band", () => {
    const balanced: BasketLeg[] = [
      { symbol: "cUSD", valueUsd: 50, target: 0.5 },
      { symbol: "USDT", valueUsd: 50, target: 0.5 },
    ];
    expect(pickRebalanceLeg(balanced, 10, { driftThresholdBps: 200 })).toBeNull();
  });

  it("never trades the hub against itself", () => {
    const leg = pickRebalanceLeg(legs(), 100, { driftThresholdBps: 100 });
    expect(leg).not.toBeNull();
    expect(leg!.from === "cUSD" && leg!.to === "cUSD").toBe(false);
  });

  it("sells the most over-target leg into the hub", () => {
    // USDT is 30% against a 20% target; with no hub budget a buy is impossible,
    // so the sell must be chosen.
    const leg = pickRebalanceLeg(legs(), 0, { driftThresholdBps: 100 });
    expect(leg).toMatchObject({ from: "USDT", to: "cUSD" });
    expect(leg!.driftBps).toBeCloseTo(1000);
    expect(leg!.amountUsd).toBeCloseTo(10); // the excess over target
    expect(leg!.rationale).toContain("USDT");
  });

  it("buys an under-target leg out of the hub, never spending more hub than offered", () => {
    const leg = pickRebalanceLeg(
      [
        { symbol: "cUSD", valueUsd: 50, target: 0.5 },
        { symbol: "cKES", valueUsd: 20, target: 0.5 },
      ],
      3, // only 3 cUSD available for buys
      { driftThresholdBps: 100 },
    );
    expect(leg).toMatchObject({ from: "cUSD", to: "cKES" });
    expect(leg!.amountUsd).toBeCloseTo(3);
  });

  it("honours the per-leg ceiling", () => {
    const leg = pickRebalanceLeg(legs(), 0, { driftThresholdBps: 100, maxLegUsd: 2 });
    expect(leg!.amountUsd).toBeCloseTo(2);
  });

  it("skips legs whose actionable size is below the dust floor", () => {
    const leg = pickRebalanceLeg(legs(), 0, { driftThresholdBps: 100, maxLegUsd: 0.001 });
    expect(leg).toBeNull();
  });

  it("lets the signal break a tie: the cheaper leg is the better buy", () => {
    // Two equally under-target legs; only the signal distinguishes them.
    const tied: BasketLeg[] = [
      { symbol: "cUSD", valueUsd: 60, target: 0.4 },
      { symbol: "cKES", valueUsd: 20, target: 0.3 },
      { symbol: "cGHS", valueUsd: 20, target: 0.3 },
    ];
    const leg = pickRebalanceLeg(tied, 100, {
      driftThresholdBps: 100,
      // cGHS is trading well below its recent average, so it should win the buy.
      signalBySymbol: { cKES: 0, cGHS: -400 },
      signalWeight: 1,
    });
    expect(leg).toMatchObject({ from: "cUSD", to: "cGHS" });
    expect(leg!.rationale).toContain("below its recent average");
  });
});
