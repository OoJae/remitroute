import { describe, it, expect } from "vitest";
import { toDataSuffix, fromDataSuffix } from "@celo/attribution-tags";
import { attributionSuffix, withAttribution } from "../shared/attribution.js";

describe("attribution suffix wiring", () => {
  it("is a clean no-op when ATTRIBUTION_TAG is unset (test env)", () => {
    expect(attributionSuffix()).toBeUndefined();
    expect(withAttribution("0xa9059cbb")).toBe("0xa9059cbb");
  });
  it("SDK round-trips an assigned-style code (celo_ + 12 hex)", () => {
    const suffix = toDataSuffix("celo_a1b2c3d4e5f6");
    const decoded = fromDataSuffix(suffix);
    expect(decoded?.codes).toContain("celo_a1b2c3d4e5f6");
  });
  it("a suffix appended to real calldata still decodes (EVM-trailing-bytes model)", () => {
    const calldata = "0xa9059cbb" + "00".repeat(64);
    const tagged = (calldata + toDataSuffix("celo_a1b2c3d4e5f6").slice(2)) as `0x${string}`;
    const decoded = fromDataSuffix(tagged);
    expect(decoded?.codes).toEqual(["celo_a1b2c3d4e5f6"]);
  });
});
