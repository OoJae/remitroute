// Build the ERC-8004 registration JSON by filling the placeholders in the
// provided registration/remitroute-agent.json with live config. Used by both
// register.ts (to pin and mint) and the /.well-known/agent.json route.
import { config } from "./config.js";
import { registries } from "./erc8004.js";
import { REGISTRATION_TEMPLATE } from "./registrationTemplate.js";

export interface RegistrationDoc {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  registrations?: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust: string[];
  // Opt-in Aigora marketplace discovery tag (self-declared; unknown keys are
  // ignored by other ERC-8004 readers, so this is safe to carry everywhere).
  onAigora?: boolean;
}

// owner is the agent wallet address that registers and owns the identity.
// baseUrlOverride lets callers (e.g. the tunnel URL refresher) build against a
// new public URL before the process config is reloaded.
// owner is retained for call-site compatibility; the agent wallet is now set
// on-chain via setAgentWallet rather than carried in the metadata (per the
// EIP-8004 registration-v1 schema), so it is no longer embedded here.
export function buildRegistration(owner: string, baseUrlOverride?: string): RegistrationDoc {
  void owner;
  const tmpl = REGISTRATION_TEMPLATE;
  const base = (baseUrlOverride ?? config.APP_BASE_URL).replace(/\/$/, "");
  const chainId = config.ERC8004_NETWORK === "mainnet" ? 42220 : 11142220;

  const services = tmpl.services.map((s) => ({
    ...s,
    endpoint: s.endpoint.replace("https://<YOUR_DOMAIN>", base),
  }));

  // When a Self Agent ID is registered, advertise it as a human-backed trust
  // service and ensure "validation" is in supportedTrust.
  const trust = new Set(tmpl.supportedTrust);
  if (config.SELF_AGENT_ID) {
    services.push({ name: "Self", endpoint: `https://app.self.xyz/agent/${config.SELF_AGENT_ID}` });
    trust.add("validation");
  }

  const doc: RegistrationDoc = {
    ...tmpl,
    services,
    supportedTrust: [...trust],
  };
  // Link the on-chain identity so the metadata is self-describing (CAIP-10).
  if (config.AGENT_ID) {
    doc.registrations = [
      { agentId: Number(config.AGENT_ID), agentRegistry: `eip155:${chainId}:${registries.identity}` },
    ];
  }
  // Drop the IPFS image placeholder if it was not replaced; it is optional.
  if (doc.image && doc.image.includes("<IPFS_IMAGE_CID>")) delete doc.image;
  return doc;
}
