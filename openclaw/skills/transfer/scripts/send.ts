// Scheduled stablecoin transfer (remittance or bill drip), and the Phase 1
// mainnet smoke test. Resolves the token, validates the recipient, enforces
// caps, builds the transfer with feeCurrency set, and either dry-runs or sends.
//
// Run (dry run):
//   pnpm skill:send -- --user <id> --to 0x... --amount 0.01 --token cUSD
import {
  erc20Abi,
  getAddress,
  isAddress,
  parseUnits,
  type Hex,
} from "viem";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users, executions } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { walletClientFor, publicClient, celo } from "../../../../shared/viem.js";
import { decryptKey } from "../../../../shared/crypto.js";
import { checkCaps } from "../../../../shared/caps.js";
import { reconcileTx } from "../../../../shared/reconcile.js";
import { log } from "../../../../shared/log.js";

const ArgSchema = z.object({
  user: z.string().uuid("user must be a uuid"),
  to: z.string().refine((a) => isAddress(a), "to must be a valid address"),
  amount: z.string().refine((a) => Number(a) > 0, "amount must be positive"),
  token: z.string().min(1),
  kind: z.enum(["remittance", "bill_drip"]).default("remittance"),
  // Set when dispatched by the scheduler, so the execution links to its schedule.
  scheduleId: z.string().uuid().optional(),
  cycleId: z.string().uuid().optional(),
});

export interface SendArgs {
  user: string;
  to: string;
  amount: string;
  token: string;
  kind?: "remittance" | "bill_drip";
  scheduleId?: string;
  cycleId?: string;
}

export async function send(rawArgs: SendArgs): Promise<{ status: string; txHash?: string }> {
  const args = ArgSchema.parse(rawArgs);
  const token = resolveToken(args.token);
  const recipient = getAddress(args.to);
  const amountUnits = parseUnits(args.amount, token.decimals);
  const amountNum = Number(args.amount);
  const feeCurrency = feeCurrencyAdapter();

  // Resolve the funding sub-wallet for this user.
  const [user] = await db.select().from(users).where(eq(users.id, args.user));
  if (!user) throw new Error(`unknown user ${args.user}`);

  // Caps first. Skip and log if a cap would be breached.
  const cap = await checkCaps(args.user, amountNum);
  if (!cap.allowed) {
    log.warn({ user: args.user, reason: cap.reason }, "transfer skipped: cap breach");
    await recordExecution({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "skipped_cap",
      amountIn: args.amount,
      tokenIn: args.token,
      feeCurrency: config.FEE_CURRENCY,
      error: cap.reason ?? "cap breach",
    });
    return { status: "skipped_cap" };
  }

  const txRequest = {
    address: token.address,
    abi: erc20Abi,
    functionName: "transfer" as const,
    args: [recipient, amountUnits] as const,
    feeCurrency,
  };

  // DRY_RUN: build and log the tx, write a dry_run row, never send.
  if (config.DRY_RUN) {
    log.info(
      {
        from: user.walletAddress,
        to: recipient,
        token: args.token,
        amount: args.amount,
        feeCurrency,
        chainId: celo.id,
      },
      "DRY_RUN transfer built, not sent",
    );
    await recordExecution({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "dry_run",
      amountIn: args.amount,
      tokenIn: args.token,
      feeCurrency: config.FEE_CURRENCY,
    });
    return { status: "dry_run" };
  }

  // Real send. Decrypt the sub-wallet key, send through the fee-abstraction path.
  // Guard: the agent treasury smoke test uses the agent key; user sends use the
  // user sub-wallet key. Here we use the user sub-wallet key reference.
  const pk = decryptKey(user.walletKeyRef) as Hex;

  const wallet = walletClientFor(pk);
  let txHash: string | undefined;
  try {
    txHash = await wallet.writeContract({ ...txRequest, account: wallet.account!, chain: celo });
    log.info({ txHash, to: recipient, amount: args.amount }, "transfer sent");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    await recordExecution({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status,
      txHash,
      amountIn: args.amount,
      tokenIn: args.token,
      feeCurrency: config.FEE_CURRENCY,
    });
    return { status, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Reconcile on chain: if the tx was broadcast it may have mined despite this
    // error, so we never blindly mark it failed (which would let it be retried
    // and double-send). Only a never-broadcast error yields a retriable "failed".
    const status = await reconcileTx(txHash);
    log.error({ err, to: recipient, reconciled: status }, "transfer error; reconciled");
    await recordExecution({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status,
      txHash,
      amountIn: args.amount,
      tokenIn: args.token,
      feeCurrency: config.FEE_CURRENCY,
      error: status === "confirmed" ? undefined : message,
    });
    return { status, txHash };
  }
}

interface ExecutionRow {
  userId: string;
  scheduleId?: string;
  cycleId?: string;
  kind: string;
  status: string;
  txHash?: string;
  amountIn: string;
  tokenIn: string;
  feeCurrency: string;
  error?: string;
}

async function recordExecution(row: ExecutionRow): Promise<void> {
  await db.insert(executions).values({
    userId: row.userId,
    scheduleId: row.scheduleId ?? null,
    cycleId: row.cycleId ?? null,
    kind: row.kind,
    status: row.status,
    txHash: row.txHash ?? null,
    amountIn: row.amountIn,
    tokenIn: row.tokenIn,
    feeCurrency: row.feeCurrency,
    error: row.error ?? null,
  });
}

// CLI: parse --flag value pairs.
function parseCliArgs(argv: string[]): SendArgs {
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
  return out as unknown as SendArgs;
}

const invokedDirectly = process.argv[1]?.endsWith("send.ts");
if (invokedDirectly) {
  send(parseCliArgs(process.argv.slice(2)))
    .then(async (r) => {
      await pool.end();
      process.exit(r.status === "failed" ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "send script failed");
      await pool.end();
      process.exit(1);
    });
}
