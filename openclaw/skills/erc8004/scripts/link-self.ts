// Link the registered Self Agent ID to the ERC-8004 identity. After the operator
// registers RemitRoute's human-backed Self Agent ID at app.ai.self.xyz (binding
// to the owner wallet), this verifies it via @selfxyz/agent-sdk, rebuilds the
// registration JSON to advertise the Self endpoint, pins it, and updates the
// ERC-8004 agentURI with setAgentURI (no re-mint).
//
// Preview:  tsx openclaw/skills/erc8004/scripts/link-self.ts
// Execute:  tsx openclaw/skills/erc8004/scripts/link-self.ts --execute
import { getAddress, type Hex } from "viem";
import { getAgentInfo, getAgentsForHuman } from "@selfxyz/agent-sdk";
import { config } from "../../../../shared/config.js";
import {
  erc8004Network,
  erc8004PublicClient,
  erc8004WalletFor,
  erc8004FeeOpts,
  erc8004Chain,
  registries,
  identityRegistryAbi,
} from "../../../../shared/erc8004.js";
import { pinJson } from "../../../../shared/ipfs.js";
import { buildRegistration } from "../../../../shared/registration.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { db, pool } from "../../../../shared/db/client.js";
import { treasuryActions } from "../../../../shared/db/schema.js";
import { log } from "../../../../shared/log.js";

async function main(execute: boolean): Promise<void> {
  if (!config.AGENT_ID) throw new Error("AGENT_ID not set (register on ERC-8004 first)");
  if (!config.AGENT_PRIVATE_KEY || !config.AGENT_WALLET_ADDRESS) {
    throw new Error("owner AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS are required");
  }
  const owner = getAddress(config.AGENT_WALLET_ADDRESS);

  // Resolve the Self Agent ID: use SELF_AGENT_ID if set, else discover the
  // agent registered under the owner (human) wallet.
  let selfId = config.SELF_AGENT_ID ? Number(config.SELF_AGENT_ID) : undefined;
  if (selfId === undefined) {
    const agents = await getAgentsForHuman(owner, { network: "mainnet" });
    log.info({ owner, agents }, "agents registered for owner (human)");
    const list = (agents as { agents?: Array<{ agentId: number }> }).agents ?? [];
    if (list.length === 0) {
      throw new Error(
        "no Self Agent ID found for the owner wallet; register at app.ai.self.xyz first, then set SELF_AGENT_ID",
      );
    }
    selfId = list[0]!.agentId;
  }

  // Verify the Self Agent ID is registered and human-backed.
  const info = await getAgentInfo(selfId, { network: "mainnet" });
  log.info(
    {
      selfId,
      isVerified: info.isVerified,
      strengthLabel: info.strengthLabel,
      verificationStrength: info.verificationStrength,
      nationality: info.credentials?.nationality,
      agentAddress: info.agentAddress,
      registeredAt: info.registeredAt,
    },
    "Self Agent ID info",
  );
  if (!info.isVerified) {
    throw new Error(`Self Agent ID ${selfId} is not verified (human-backed) yet`);
  }

  // Rebuild the registration JSON (now including the Self endpoint, since
  // SELF_AGENT_ID is set) and pin it.
  const doc = buildRegistration(owner);
  const hasSelf = doc.services.some((s) => s.name === "Self");
  if (!hasSelf) {
    throw new Error("SELF_AGENT_ID not set in config; set it so the registration advertises Self");
  }
  const pinned = await pinJson(doc);
  const agentURI =
    pinned?.uri ?? `${config.APP_BASE_URL.replace(/\/$/, "")}/.well-known/agent.json`;
  log.info({ agentURI, selfId, network: erc8004Network }, "updated registration prepared");

  if (!execute) {
    log.info({ doc }, "PREVIEW only: rerun with --execute to setAgentURI on-chain");
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
    functionName: "setAgentURI",
    args: [BigInt(config.AGENT_ID), agentURI],
    dataSuffix: attributionSuffix(),
    ...erc8004FeeOpts(),
  });
  await erc8004PublicClient.waitForTransactionReceipt({ hash });
  log.info({ hash, agentId: config.AGENT_ID, agentURI, selfId }, "agentURI updated with Self Agent ID");

  await db.insert(treasuryActions).values({
    strategy: "self_link",
    txHash: hash,
    status: "confirmed",
    detail: {
      selfAgentId: selfId,
      agentURI,
      isVerified: info.isVerified,
      strengthLabel: info.strengthLabel,
      nationality: info.credentials?.nationality ?? null,
      agentAddress: info.agentAddress,
      network: erc8004Network,
    },
  });
}

const execute = process.argv.includes("--execute");
main(execute)
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, "link-self failed");
    await pool.end();
    process.exit(1);
  });
