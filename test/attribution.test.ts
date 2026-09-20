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
  // Asserted against the literal, not against config. ATTRIBUTION_TAG is unset
  // in CI, so an early return here left the only real drift guard disabled
  // everywhere it mattered while the surrounding tests compared the constant to
  // itself and passed regardless. The tag is a public attribution code assigned
  // at registration, not a secret, so hard-coding it is the point: it is the
  // independent value the constant must keep matching.
  const REGISTERED_TAG = "celo_716fa1c99481";

  it("matches what the SDK derives from the registered tag", () => {
    expect(CLIENT_ATTRIBUTION_TAG).toBe(REGISTERED_TAG);
    expect(CLIENT_ATTRIBUTION_SUFFIX).toBe(toDataSuffix(REGISTERED_TAG));
  });

  it("agrees with the configured tag wherever one is set", () => {
    if (!config.ATTRIBUTION_TAG) return; // genuinely absent in CI
    expect(config.ATTRIBUTION_TAG).toBe(REGISTERED_TAG);
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
