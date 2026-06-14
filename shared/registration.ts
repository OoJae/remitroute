// Build the ERC-8004 registration JSON by filling the placeholders in the
// provided registration/remitroute-agent.json with live config. Used by both
// register.ts (to pin and mint) and the /.well-known/agent.json route.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, "..", "registration", "remitroute-agent.json");

export interface RegistrationDoc {
  type: string;
  name: string;
  description: string;
  image?: string;
  endpoints: Array<{ type: string; url?: string; address?: string; chainId?: number; id?: string }>;
  supportedTrust: string[];
}

// owner is the agent wallet address that registers and owns the identity.
// baseUrlOverride lets callers (e.g. the tunnel URL refresher) build against a
// new public URL before the process config is reloaded.
export function buildRegistration(owner: string, baseUrlOverride?: string): RegistrationDoc {
  const tmpl = JSON.parse(readFileSync(templatePath, "utf8")) as RegistrationDoc;
  const base = (baseUrlOverride ?? config.APP_BASE_URL).replace(/\/$/, "");
  const chainId = config.ERC8004_NETWORK === "mainnet" ? 42220 : 11142220;

  const endpoints = tmpl.endpoints.map((e) => {
    if (e.type === "wallet") return { ...e, address: owner, chainId };
    if (e.url) return { ...e, url: e.url.replace("https://<YOUR_DOMAIN>", base) };
    return e;
  });

  // When a Self Agent ID is registered, advertise it as a human-backed trust
  // endpoint and ensure "validation" is in supportedTrust.
  const finalEndpoints = [...endpoints];
  const trust = new Set(tmpl.supportedTrust);
  if (config.SELF_AGENT_ID) {
    finalEndpoints.push({ type: "self", id: config.SELF_AGENT_ID });
    trust.add("validation");
  }

  const doc: RegistrationDoc = {
    ...tmpl,
    endpoints: finalEndpoints,
    supportedTrust: [...trust],
  };
  // Drop the IPFS image placeholder if it was not replaced; it is optional.
  if (doc.image && doc.image.includes("<IPFS_IMAGE_CID>")) delete doc.image;
  return doc;
}
