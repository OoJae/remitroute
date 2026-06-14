import type { RegistrationDoc } from "./registration.js";

// The ERC-8004 registration template, inlined as a constant so it bundles cleanly
// in every runtime including serverless functions (no disk read, no file-tracing
// concerns). registration/remitroute-agent.json is kept as the canonical record;
// keep the two in sync. buildRegistration treats this as read-only.
export const REGISTRATION_TEMPLATE: RegistrationDoc = {
  type: "Agent",
  name: "RemitRoute",
  description:
    "Autonomous personal finance agent for emerging markets on Celo. Users set simple rules once in the MiniPay Mini App, for example save 10 percent every Friday, keep 40 percent in cKES and rebalance weekly, send 5,000 cNGN on the 1st, or stack 2 dollars of CELO daily. RemitRoute then runs them onchain continuously on a heartbeat: recurring savings sweeps into Aave, local-currency FX swaps via Mento, scheduled remittances, and DCA, all with gas paid in stablecoins through Celo fee abstraction. Accessible via MiniPay. Paid FX-route API available to other agents via x402.",
  image: "ipfs://<IPFS_IMAGE_CID>",
  endpoints: [
    { type: "a2a", url: "https://<YOUR_DOMAIN>/.well-known/agent.json" },
    { type: "mcp", url: "https://<YOUR_DOMAIN>/mcp" },
    { type: "web", url: "https://<YOUR_DOMAIN>" },
    { type: "x402", url: "https://<YOUR_DOMAIN>/api/fx-route" },
    { type: "wallet", address: "<AGENT_WALLET_ADDRESS>", chainId: 42220 },
  ],
  supportedTrust: ["reputation", "validation"],
};
