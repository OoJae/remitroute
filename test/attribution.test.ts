import { describe, it, expect } from "vitest";
import { toDataSuffix, fromDataSuffix } from "@celo/attribution-tags";
import { attributionSuffix, withAttribution } from "../shared/attribution.js";
import { config } from "../shared/config.js";

describe("attribution suffix wiring", () => {
  it("mirrors ATTRIBUTION_TAG: appends a decodable suffix when set, no-op when unset", () => {
    const suffix = attributionSuffix();
    if (config.ATTRIBUTION_TAG) {
      expect(suffix).toBeDefined();
      expect(fromDataSuffix(suffix!)?.codes).toContain(config.ATTRIBUTION_TAG);
      expect(withAttribution("0xa9059cbb")).toBe("0xa9059cbb" + suffix!.slice(2));
    } else {
      expect(suffix).toBeUndefined();
      expect(withAttribution("0xa9059cbb")).toBe("0xa9059cbb");
    }
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
