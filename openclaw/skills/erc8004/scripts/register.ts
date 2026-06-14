// Register RemitRoute on the ERC-8004 Identity Registry. Builds the registration
// JSON, pins it to IPFS (Pinata), then calls register(agentURI) and records the
// returned agentId. Run once per network.
//
// Preview (no tx):  tsx openclaw/skills/erc8004/scripts/register.ts
// Execute (sends):  tsx openclaw/skills/erc8004/scripts/register.ts --execute
import { appendFileSync } from "node:fs";
import { decodeEventLog, getAddress, type Hex } from "viem";
import { config } from "../../../../shared/config.js";
import {
  erc8004Network,
  erc8004PublicClient,
  erc8004WalletFor,
  erc8004FeeOpts,
  registries,
  identityRegistryAbi,
} from "../../../../shared/erc8004.js";
import { erc8004Chain } from "../../../../shared/erc8004.js";
import { pinJson } from "../../../../shared/ipfs.js";
import { buildRegistration } from "../../../../shared/registration.js";
import { db, pool } from "../../../../shared/db/client.js";
import { treasuryActions } from "../../../../shared/db/schema.js";
import { log } from "../../../../shared/log.js";

async function main(execute: boolean): Promise<void> {
  // The owner wallet registers and owns the identity NFT.
  if (!config.AGENT_PRIVATE_KEY || !config.AGENT_WALLET_ADDRESS) {
    throw new Error("AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS are required to register");
  }
  const owner = getAddress(config.AGENT_WALLET_ADDRESS);

  // Build and pin the registration JSON. Fall back to the app https URL if no
  // Pinata JWT is set.
  const doc = buildRegistration(owner);
  const pinned = await pinJson(doc);
  const agentURI =
    pinned?.uri ?? `${config.APP_BASE_URL.replace(/\/$/, "")}/.well-known/agent.json`;

  log.info(
    { network: erc8004Network, identity: registries.identity, owner, agentURI },
    "registration prepared",
  );

  if (!execute) {
    log.info({ doc, agentURI }, "PREVIEW only: rerun with --execute to mint the identity");
    return;
  }

  const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = erc8004WalletFor(pk);

  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: erc8004Chain,
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [agentURI],
    ...erc8004FeeOpts(),
  });
  log.info({ hash }, "register tx sent");
  const receipt = await erc8004PublicClient.waitForTransactionReceipt({ hash });

  // Parse the Registered event for the agentId.
  let agentId: bigint | null = null;
  for (const lg of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: identityRegistryAbi, data: lg.data, topics: lg.topics });
      if (ev.eventName === "Registered") {
        agentId = (ev.args as { agentId: bigint }).agentId;
        break;
      }
    } catch {
      // not our event
    }
  }
  if (agentId === null) throw new Error("Registered event not found in receipt");

  log.info({ agentId: agentId.toString(), agentURI, network: erc8004Network }, "agent registered");

  await db.insert(treasuryActions).values({
    strategy: "erc8004_register",
    txHash: hash,
    status: "confirmed",
    detail: { agentId: agentId.toString(), agentURI, network: erc8004Network, owner },
  });

  // Persist AGENT_ID to .env so later scripts (post-metrics) can read it.
  try {
    appendFileSync(".env", `\nAGENT_ID=${agentId.toString()}\n`);
    log.info("AGENT_ID appended to .env");
  } catch (err) {
    log.warn({ err }, "could not append AGENT_ID to .env; set it manually");
  }
}

const execute = process.argv.includes("--execute");
main(execute)
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "register failed");
    await pool.end();
    process.exit(1);
  });
