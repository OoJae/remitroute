// ERC-8021 attribution suffix for every transaction the agent broadcasts. The
// hackathon-assigned ATTRIBUTION_TAG rides the tail of the calldata (the EVM
// ignores trailing bytes, so this is inert to ERC-20 transfers, the Mento
// router, the Aave pool, and EIP-3009 alike) and is what credits RemitRoute's
// on-chain volume and x402 payments on the attribution leaderboards.
//
// Two shapes because viem has two broadcast forms:
//   writeContract({ ..., dataSuffix: attributionSuffix() })  - viem appends it
//   sendTransaction({ ..., data: withAttribution(data) })    - raw data, manual
// Both are clean no-ops when ATTRIBUTION_TAG is unset.
import { concat, type Hex } from "viem";
import { toDataSuffix } from "@celo/attribution-tags";
import { config } from "./config.js";

let cached: Hex | undefined;

export function attributionSuffix(): Hex | undefined {
  if (!config.ATTRIBUTION_TAG) return undefined;
  if (!cached) cached = toDataSuffix(config.ATTRIBUTION_TAG) as Hex;
  return cached;
}

export function withAttribution(data: Hex): Hex {
  const suffix = attributionSuffix();
  return suffix ? concat([data, suffix]) : data;
}
