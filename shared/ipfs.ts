// Pin a JSON object to IPFS via Pinata and return its ipfs:// URI. Used to host
// the ERC-8004 registration file at a permanent, content-addressed URI.
import { config } from "./config.js";
import { log } from "./log.js";

const PINATA_PIN_JSON = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

export interface PinResult {
  cid: string;
  uri: string; // ipfs://<cid>
}

// Returns null when no Pinata JWT is configured, so callers can fall back to a
// public https agentURI.
export async function pinJson(obj: unknown, name = "remitroute-agent"): Promise<PinResult | null> {
  if (!config.PINATA_JWT) {
    log.warn("PINATA_JWT not set; skipping IPFS pin");
    return null;
  }
  const res = await fetch(PINATA_PIN_JSON, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.PINATA_JWT}`,
    },
    body: JSON.stringify({
      pinataContent: obj,
      pinataMetadata: { name },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pinata pin failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { IpfsHash: string };
  const cid = data.IpfsHash;
  log.info({ cid }, "pinned registration JSON to IPFS");
  return { cid, uri: `ipfs://${cid}` };
}
