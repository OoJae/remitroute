// Re-pin the ERC-8004 registration JSON to IPFS and point the onchain agentURI
// at the new CID, WITHOUT changing the public URL. Use after the registration
// content or schema changes (e.g. bringing the metadata into EIP-8004 spec
// compliance) so the onchain identity resolves to the corrected document. Real
// transaction on mainnet, so it is preview-by-default (pass --execute to send).
// Gas is paid in stablecoin via the shared fee options.
//
// Preview:  tsx openclaw/skills/erc8004/scripts/repin.ts
// Execute:  tsx openclaw/skills/erc8004/scripts/repin.ts --execute
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

async function main(execute: boolean): Promise<void> {
  if (!config.AGENT_ID) throw new Error("AGENT_ID not set");
  if (!config.AGENT_PRIVATE_KEY || !config.AGENT_WALLET_ADDRESS) {
    throw new Error("owner AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS are required");
  }
  const owner = getAddress(config.AGENT_WALLET_ADDRESS);

  // Build against the current APP_BASE_URL and pin the corrected document.
  const doc = buildRegistration(owner);
  const pinned = await pinJson(doc);
  if (!pinned) throw new Error("IPFS pin failed (is PINATA_JWT set?)");
  const agentURI = pinned.uri;
  log.info(
    { agentURI, type: doc.type, services: doc.services.length },
    execute ? "re-pinning and updating agentURI" : "PREVIEW only; rerun with --execute",
  );
  if (!execute) return;

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
  log.info({ hash, agentId: config.AGENT_ID, agentURI }, "agentURI updated to new CID");

  await db.insert(treasuryActions).values({
    strategy: "metadata_repin",
    txHash: hash,
    status: "confirmed",
    detail: { agentURI },
  });
}

const execute = process.argv.includes("--execute");
main(execute)
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "repin failed");
    await pool.end();
    process.exit(1);
  });
