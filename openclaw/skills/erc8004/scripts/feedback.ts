// Submit ERC-8004 feedback from a client wallet (a user rating the agent) and
// log it to feedback_log. The client wallet signs; never the owner/operator (the
// registry blocks self-rating). Real users sign through the Mini App; this CLI
// is for testing from a wallet we control.
//
// Run: tsx openclaw/skills/erc8004/scripts/feedback.ts --client-key 0x.. --score 90 --tag starred
import { getAddress, type Hex } from "viem";
import { config } from "../../../../shared/config.js";
import { db, pool } from "../../../../shared/db/client.js";
import { feedbackLog } from "../../../../shared/db/schema.js";
import {
  erc8004PublicClient,
  erc8004WalletFor,
  erc8004FeeOpts,
  erc8004Chain,
  erc8004Network,
  registries,
  reputationRegistryAbi,
  ZERO_HASH,
} from "../../../../shared/erc8004.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { log } from "../../../../shared/log.js";

export interface FeedbackArgs {
  clientKey: string;
  score: number;
  tag: string;
  agentId?: string;
  user?: string;
  feedbackURI?: string;
}

export async function submitFeedback(args: FeedbackArgs): Promise<{ txHash: string }> {
  const agentIdStr = args.agentId ?? config.AGENT_ID;
  if (!agentIdStr) throw new Error("AGENT_ID is required (register first or pass --agentId)");
  const agentId = BigInt(agentIdStr);

  const pk = (args.clientKey.startsWith("0x") ? args.clientKey : `0x${args.clientKey}`) as Hex;
  const wallet = erc8004WalletFor(pk);
  const client = getAddress(wallet.account!.address);

  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: erc8004Chain,
    address: registries.reputation,
    abi: reputationRegistryAbi,
    functionName: "giveFeedback",
    args: [agentId, BigInt(args.score), 0, args.tag, "", "", args.feedbackURI ?? "", ZERO_HASH],
    dataSuffix: attributionSuffix(),
    ...erc8004FeeOpts(),
  });
  await erc8004PublicClient.waitForTransactionReceipt({ hash });
  log.info({ hash, client, score: args.score, tag: args.tag, network: erc8004Network }, "feedback submitted");

  await db.insert(feedbackLog).values({
    userId: args.user ?? null,
    agentId: agentIdStr,
    clientAddress: client,
    score: args.score,
    tag: args.tag,
    txHash: hash,
  });

  return { txHash: hash };
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined) {
        out[key] = val;
        i += 1;
      }
    }
  }
  return out;
}

const invokedDirectly = process.argv[1]?.endsWith("feedback.ts");
if (invokedDirectly) {
  const a = parseCliArgs(process.argv.slice(2));
  submitFeedback({
    clientKey: a["client-key"] ?? "",
    score: Number(a.score ?? "0"),
    tag: a.tag ?? "starred",
    agentId: a.agentId,
    user: a.user,
  })
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err }, "feedback failed");
      await pool.end();
      process.exit(1);
    });
}
