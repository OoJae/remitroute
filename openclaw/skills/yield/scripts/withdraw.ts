// Withdraw a stablecoin from Aave V3 on Celo back to the user execution wallet.
// Pays gas in a stablecoin via feeCurrency. Gated by DRY_RUN. Triggered by a user
// request (Mini App or CLI) or before an action that needs the funds.
//
// Run: tsx openclaw/skills/yield/scripts/withdraw.ts --user <id> --asset cUSD --amount 0.5
//   amount "max" withdraws the full supplied balance.
import { getAddress, parseUnits, type Hex } from "viem";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, pool as dbPool } from "../../../../shared/db/client.js";
import { users, executions } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { publicClient, walletClientFor, celo } from "../../../../shared/viem.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { decryptKey } from "../../../../shared/crypto.js";
import { reconcileTx, RECEIPT_TIMEOUT_MS } from "../../../../shared/reconcile.js";
import { reserveIntent, finalizeExecution } from "../../../../shared/execLedger.js";
import { resolvePool, assertApprovedAsset, aavePoolAbi, MAX_UINT256 } from "../../../../shared/aave.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { emitReceipt } from "../../../../shared/receipts.js";
import { log } from "../../../../shared/log.js";

const ArgSchema = z.object({
  user: z.string().uuid(),
  asset: z.string().min(1),
  // A positive human amount, or "max" for the full supplied balance.
  amount: z.string().refine((a) => a === "max" || Number(a) > 0, "amount must be positive or max"),
  scheduleId: z.string().uuid().optional(),
  cycleId: z.string().uuid().optional(),
  intentId: z.string().optional(),
});

export interface WithdrawArgs {
  user: string;
  asset: string;
  amount: string;
  scheduleId?: string;
  cycleId?: string;
  intentId?: string;
}

export async function withdraw(rawArgs: WithdrawArgs): Promise<{ status: string; txHash?: string }> {
  const args = ArgSchema.parse(rawArgs);
  assertApprovedAsset(args.asset);
  const token = resolveToken(args.asset);
  const isMax = args.amount === "max";
  const amountUnits = isMax ? MAX_UINT256 : parseUnits(args.amount, token.decimals);
  const feeCurrency = feeCurrencyAdapter();

  const [user] = await db.select().from(users).where(eq(users.id, args.user));
  if (!user) throw new Error(`unknown user ${args.user}`);
  const to = getAddress(user.walletAddress);

  const poolAddress = await resolvePool();

  if (config.DRY_RUN) {
    log.info(
      {
        to,
        asset: args.asset,
        amount: args.amount,
        pool: poolAddress,
        feeCurrency,
        chainId: celo.id,
      },
      "DRY_RUN withdraw built, not sent",
    );
    await recordRow({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      status: "dry_run",
      amountIn: isMax ? null : args.amount,
      tokenIn: args.asset,
    });
    return { status: "dry_run" };
  }

  // Reserve the intent before broadcasting so a crash-then-reclaim re-run cannot
  // double-withdraw from Aave.
  let pendingId: string | undefined;
  if (args.intentId) {
    const id = await reserveIntent({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      intentId: args.intentId,
      kind: "yield_withdraw",
      amountIn: isMax ? null : args.amount,
      tokenIn: args.asset,
    });
    if (id === null) {
      log.warn({ intentId: args.intentId, scheduleId: args.scheduleId }, "intent already reserved; skipping duplicate withdraw");
      return { status: "skipped_duplicate" };
    }
    pendingId = id;
  }

  const pk = decryptKey(user.walletKeyRef) as Hex;
  const wallet = walletClientFor(pk);
  const account = wallet.account!;
  let txHash: string | undefined;

  try {
    txHash = await wallet.writeContract({
      account,
      chain: celo,
      address: poolAddress,
      abi: aavePoolAbi,
      functionName: "withdraw",
      args: [token.address, amountUnits, to],
      feeCurrency,
      dataSuffix: attributionSuffix(),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: RECEIPT_TIMEOUT_MS });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    log.info({ txHash, status, asset: args.asset, amount: args.amount }, "withdraw sent");
    if (pendingId) {
      await finalizeExecution(pendingId, { status, txHash });
    } else {
      await recordRow({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        status,
        txHash,
        amountIn: isMax ? null : args.amount,
        tokenIn: args.asset,
      });
    }
    return { status, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Reconcile on chain so a broadcast withdraw is never marked failed-and-retried.
    const status = await reconcileTx(txHash);
    log.error({ err, asset: args.asset, reconciled: status }, "withdraw error; reconciled");
    if (pendingId) {
      await finalizeExecution(pendingId, { status, txHash, error: status === "confirmed" ? undefined : message });
    } else {
      await recordRow({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        status,
        txHash,
        amountIn: isMax ? null : args.amount,
        tokenIn: args.asset,
        error: message,
      });
    }
    return { status, txHash };
  }
}

interface WithdrawRow {
  userId: string;
  scheduleId?: string;
  cycleId?: string;
  status: string;
  txHash?: string;
  amountIn: string | null;
  tokenIn: string;
  error?: string;
}

async function recordRow(row: WithdrawRow): Promise<void> {
  const [inserted] = await db
    .insert(executions)
    .values({
      userId: row.userId,
      scheduleId: row.scheduleId ?? null,
      cycleId: row.cycleId ?? null,
      kind: "yield_withdraw",
      status: row.status,
      txHash: row.txHash ?? null,
      amountIn: row.amountIn,
      tokenIn: row.tokenIn,
      feeCurrency: config.FEE_CURRENCY,
      error: row.error ?? null,
    })
    .returning();
  await emitReceipt(inserted);
}

function parseCliArgs(argv: string[]): WithdrawArgs {
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
  return out as unknown as WithdrawArgs;
}

const invokedDirectly = process.argv[1]?.endsWith("withdraw.ts");
if (invokedDirectly) {
  withdraw(parseCliArgs(process.argv.slice(2)))
    .then(async (r) => {
      await dbPool.end();
      process.exit(r.status === "failed" ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "withdraw script failed");
      await dbPool.end();
      process.exit(1);
    });
}
