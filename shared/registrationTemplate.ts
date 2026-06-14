import type { RegistrationDoc } from "./registration.js";

// The ERC-8004 registration template, inlined as a constant so it bundles cleanly
// in every runtime including serverless functions (no disk read, no file-tracing
// concerns). registration/remitroute-agent.json is kept as the canonical record;
// keep the two in sync. buildRegistration treats this as read-only.
export const REGISTRATION_TEMPLATE: RegistrationDoc = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "RemitRoute",
  description:
    "Autonomous personal finance agent for emerging markets on Celo. Users set simple rules once in the MiniPay Mini App, for example save 10 percent every Friday, keep 40 percent in cKES and rebalance weekly, send 5,000 cNGN on the 1st, or stack 2 dollars of CELO daily. RemitRoute then runs them onchain continuously on a heartbeat: recurring savings sweeps into Aave, local-currency FX swaps via Mento, scheduled remittances, and DCA, all with gas paid in stablecoins through Celo fee abstraction. Accessible via MiniPay. Paid FX-route API available to other agents via x402.",
  image: "ipfs://<IPFS_IMAGE_CID>",
  services: [
    { name: "web", endpoint: "https://<YOUR_DOMAIN>" },
    { name: "A2A", endpoint: "https://<YOUR_DOMAIN>/.well-known/agent.json" },
    { name: "MCP", endpoint: "https://<YOUR_DOMAIN>/mcp", version: "2025-06-18" },
    { name: "x402", endpoint: "https://<YOUR_DOMAIN>/api/fx-route" },
  ],
  supportedTrust: ["reputation", "validation"],
};
