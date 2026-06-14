// Re-sync the public URL after the cloudflared quick-tunnel restarts with a new
// hostname. Reads the live trycloudflare URL from the remitroute-tunnel journal,
// writes it to APP_BASE_URL in .env, re-pins the registration JSON, and updates
// the ERC-8004 agentURI (setAgentURI) so the onchain identity points at the new
// URL. Restart remitroute-web afterwards so it serves the new APP_BASE_URL.
//
// Preview:  tsx openclaw/skills/remitroute-core/scripts/refresh-public-url.ts
// Execute:  tsx openclaw/skills/remitroute-core/scripts/refresh-public-url.ts --execute
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { config } from "../../../../shared/config.js";
import {
  erc8004Chain,
  erc8004PublicClient,
  erc8004WalletFor,
  erc8004FeeOpts,
  registries,
  identityRegistryAbi,
} from "../../../../shared/erc8004.js";
import { buildRegistration } from "../../../../shared/registration.js";
import { pinJson } from "../../../../shared/ipfs.js";
import { db, pool } from "../../../../shared/db/client.js";
import { treasuryActions } from "../../../../shared/db/schema.js";
import { log } from "../../../../shared/log.js";

const ENV_PATH = "/root/remitroute/.env";

// The latest https://*.trycloudflare.com URL the managed tunnel is serving.
function currentTunnelUrl(): string {
  const out = execSync("journalctl -u remitroute-tunnel --no-pager -n 300", { encoding: "utf8" });
  const matches = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  if (!matches || matches.length === 0) {
    throw new Error("no trycloudflare URL found in the remitroute-tunnel journal yet");
  }
  return matches[matches.length - 1]!;
}

function updateEnvAppBaseUrl(url: string): void {
  const txt = readFileSync(ENV_PATH, "utf8");
  const next = /^APP_BASE_URL=/m.test(txt)
    ? txt.replace(/^APP_BASE_URL=.*$/m, `APP_BASE_URL=${url}`)
    : `${txt.replace(/\n?$/, "\n")}APP_BASE_URL=${url}\n`;
  writeFileSync(ENV_PATH, next);
}

async function main(execute: boolean): Promise<void> {
  if (!config.AGENT_ID) throw new Error("AGENT_ID not set");
  if (!config.AGENT_PRIVATE_KEY || !config.AGENT_WALLET_ADDRESS) {
    throw new Error("owner AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS are required");
  }
  const owner = getAddress(config.AGENT_WALLET_ADDRESS);

  const url = currentTunnelUrl();
  if (url === config.APP_BASE_URL.replace(/\/$/, "")) {
    log.info({ url }, "tunnel URL unchanged; nothing to do");
    return;
  }
  log.info({ from: config.APP_BASE_URL, to: url }, "new tunnel URL detected");

  // Build the registration against the NEW url (config is still the old one).
  const doc = buildRegistration(owner, url);
  const pinned = await pinJson(doc);
  const agentURI = pinned?.uri ?? `${url}/.well-known/agent.json`;
  log.info({ agentURI }, "registration prepared for new URL");

  if (!execute) {
    log.info({ url, agentURI }, "PREVIEW only: rerun with --execute to write .env + setAgentURI");
    return;
  }

  updateEnvAppBaseUrl(url);
  log.info({ url }, "APP_BASE_URL updated in .env (restart remitroute-web to apply)");

  const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = erc8004WalletFor(pk);
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: erc8004Chain,
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: [BigInt(config.AGENT_ID), agentURI],
    ...erc8004FeeOpts(),
  });
  await erc8004PublicClient.waitForTransactionReceipt({ hash });
  log.info({ hash, agentId: config.AGENT_ID, agentURI }, "agentURI updated to new URL");

  await db.insert(treasuryActions).values({
    strategy: "url_refresh",
    txHash: hash,
    status: "confirmed",
    detail: { url, agentURI },
  });
}

const execute = process.argv.includes("--execute");
main(execute)
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "refresh-public-url failed");
    await pool.end();
    process.exit(1);
  });
