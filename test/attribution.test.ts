import { describe, it, expect } from "vitest";
import { toDataSuffix, fromDataSuffix } from "@celo/attribution-tags";
import { attributionSuffix, withAttribution } from "../shared/attribution.js";
import { config } from "../shared/config.js";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import {
  CLIENT_ATTRIBUTION_TAG,
  CLIENT_ATTRIBUTION_SUFFIX,
  withClientAttribution,
} from "../shared/attributionClient.js";

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

// The client bundle cannot import shared/attribution.ts (it pulls in dotenv and
// the server config schema), so shared/attributionClient.ts carries the suffix as
// a constant. These assertions are what stop that constant from silently drifting
// away from the configured tag.
describe("client attribution constant", () => {
  it("matches what the SDK derives from the configured tag", () => {
    if (!config.ATTRIBUTION_TAG) return; // unset in CI; server path is a no-op there
    expect(CLIENT_ATTRIBUTION_TAG).toBe(config.ATTRIBUTION_TAG);
    expect(CLIENT_ATTRIBUTION_SUFFIX).toBe(toDataSuffix(config.ATTRIBUTION_TAG));
  });

  it("decodes back to the registered tag", () => {
    const decoded = fromDataSuffix(CLIENT_ATTRIBUTION_SUFFIX);
    expect(decoded?.codes).toContain(CLIENT_ATTRIBUTION_TAG);
  });

  it("survives being appended to real ERC20 transfer calldata", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: ["0x000000000000000000000000000000000000dEaD", parseUnits("1", 18)],
    });
    const tagged = withClientAttribution(data);
    expect(tagged.startsWith(data)).toBe(true);
    expect(fromDataSuffix(tagged)?.codes).toContain(CLIENT_ATTRIBUTION_TAG);
  });
});
