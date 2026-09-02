// Client-safe ERC-8021 attribution for transactions the USER signs in the browser.
//
// The server path (shared/attribution.ts) cannot be used here: it imports
// shared/config.ts, which pulls in dotenv and a server-only zod schema. So this
// module carries the suffix as a constant instead.
//
// The constant is not magic. It is exactly what the SDK produces for our
// hackathon-assigned tag, and test/attribution.test.ts asserts that equality on
// every run, so the two can never drift:
//
//   toDataSuffix("celo_716fa1c99481")
//     = 0x63656c6f5f373136666131633939343831110080218021802180218021802180218021
//
// Layout is 35 bytes: the 17-byte ASCII code, a 1-byte length (0x11 = 17), a
// 1-byte schema id (0x00), then the 16-byte ERC-8021 marker. Decoding it returns
// { codes: ["celo_716fa1c99481"], schemaId: 0 }.
//
// Appending it is safe for both call sites: a trailing suffix is inert to an
// ERC-20 transfer and to giveFeedback, since neither reads calldata past its
// declared arguments.
import { concat, type Hex } from "viem";

export const CLIENT_ATTRIBUTION_TAG = "celo_716fa1c99481";

export const CLIENT_ATTRIBUTION_SUFFIX =
  "0x63656c6f5f373136666131633939343831110080218021802180218021802180218021" as Hex;

// Append the attribution suffix to calldata the user is about to sign. Without
// this, a user-signed transaction is invisible to the leaderboard, which credits
// only transactions carrying the registered tag.
export function withClientAttribution(data: Hex): Hex {
  return concat([data, CLIENT_ATTRIBUTION_SUFFIX]);
}
