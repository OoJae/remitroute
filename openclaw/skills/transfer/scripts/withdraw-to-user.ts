// User-initiated withdraw: move funds from a user's execution wallet back to
// their OWN MiniPay address. Unlike the automated engine (which stays DRY_RUN),
// this is real onchain when WITHDRAW_LIVE is true, because it only ever returns
// the depositor's own funds to the address they onboarded with. The destination
// is taken from the users row server-side and can never be supplied by a caller.
//
// Run (real, WITHDRAW_LIVE=true):
//   tsx openclaw/skills/transfer/scripts/withdraw-to-user.ts --user <id> --token cUSD --amount max
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users, executions } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { walletClientFor, publicClient, celo } from "../../../../shared/viem.js";
import { decryptKey } from "../../../../shared/crypto.js";
import { reconcileTx, RECEIPT_TIMEOUT_MS } from "../../../../shared/reconcile.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { queueReceipt, flushReceipts } from "../../../../shared/receipts.js";
import { log } from "../../../../shared/log.js";

// Tokens a user can withdraw. Gas is always paid in cUSD via fee abstraction.
const WITHDRAW_TOKENS = ["cUSD", "USDC", "cEUR"] as const;

// Explicit, modest gas parameters for the withdraw transfer. A node reserves
// gasLimit * maxFeePerGas upfront in the fee currency (cUSD) before it will
// submit, so bounding both keeps that reservation small and deterministic
// (250000 * 25 gwei ~= 0.00625 cUSD) instead of letting the RPC fill a large
// one. Celo base fee is a few gwei, so 25 gwei is ample headroom.
const WITHDRAW_GAS = {
  gas: 250000n,
  maxFeePerGas: 25_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
} as const;

// cUSD to hold back for a full cUSD withdraw so the upfront gas reservation
// above is covered. Comfortably exceeds gasLimit * maxFeePerGas.
const CUSD_GAS_RESERVE = "0.01";

const ArgSchema = z.object({
  user: z.string().uuid("user must be a uuid"),
  token: z.enum(WITHDRAW_TOKENS),
  // A positive decimal amount, or "max" for the full idle balance.
  amount: z
    .string()
    .refine((a) => a === "max" || Number(a) > 0, "amount must be positive or 'max'"),
});

export interface WithdrawArgs {
  user: string;
  token: (typeof WITHDRAW_TOKENS)[number];
  amount: string;
}

export async function withdraw(
  rawArgs: WithdrawArgs,
): Promise<{ status: string; txHash?: string; amount?: string }> {
  const args = ArgSchema.parse(rawArgs);
  const token = resolveToken(args.token);
  const feeCurrency = feeCurrencyAdapter();

  const [user] = await db.select().from(users).where(eq(users.id, args.user));
  if (!user) throw new Error(`unknown user ${args.user}`);
  if (!user.minipayAddress || !isAddress(user.minipayAddress)) {
    throw new Error("user has no valid MiniPay address to withdraw to");
  }
  // Destination is the user's own onboarded address. Never caller-supplied.
  const to = getAddress(user.minipayAddress);

  // Current idle balance of the chosen token in the execution wallet.
  const balance = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [user.walletAddress as `0x${string}`],
  })) as bigint;

  // Resolve the amount in base units. "max" leaves a gas reserve for cUSD, since
  // gas for the withdraw itself is pre-debited from the same cUSD balance.
  let amountUnits: bigint;
  if (args.amount === "max") {
    const reserve = args.token === "cUSD" ? parseUnits(CUSD_GAS_RESERVE, token.decimals) : 0n;
    amountUnits = balance > reserve ? balance - reserve : 0n;
  } else {
    amountUnits = parseUnits(args.amount, token.decimals);
  }

  if (amountUnits <= 0n) {
    return { status: "skipped_empty", amount: "0" };
  }
  if (amountUnits > balance) {
    throw new Error(
      `amount exceeds balance (have ${formatUnits(balance, token.decimals)} ${args.token})`,
    );
  }
  const amountStr = formatUnits(amountUnits, token.decimals);

  const txRequest = {
    address: token.address,
    abi: erc20Abi,
    functionName: "transfer" as const,
    args: [to, amountUnits] as const,
    feeCurrency,
    ...WITHDRAW_GAS,
  };

  // WITHDRAW_LIVE off: build and log, write a dry_run row, never send.
  if (!config.WITHDRAW_LIVE) {
    log.info(
      { from: user.walletAddress, to, token: args.token, amount: amountStr },
      "WITHDRAW_LIVE off: withdraw built, not sent",
    );
    await recordExecution({
      userId: args.user,
      status: "dry_run",
      amountIn: amountStr,
      tokenIn: args.token,
    });
    return { status: "dry_run", amount: amountStr };
  }

  // Real withdraw. Decrypt the user's sub-wallet key and send via fee abstraction.
  const pk = decryptKey(user.walletKeyRef) as Hex;
  const wallet = walletClientFor(pk);

  let txHash: string | undefined;
  try {
    txHash = await wallet.writeContract({ ...txRequest, account: wallet.account!, chain: celo, dataSuffix: attributionSuffix() });
    log.info({ txHash, to, amount: amountStr, token: args.token }, "withdraw sent");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: RECEIPT_TIMEOUT_MS });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    await recordExecution({
      userId: args.user,
      status,
      txHash,
      amountIn: amountStr,
      tokenIn: args.token,
    });
    return { status, txHash, amount: amountStr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Reconcile on chain: a broadcast withdraw that merely timed out must never be
    // recorded "failed" (which invites the user to resubmit and double-debit).
    const status = await reconcileTx(txHash);
    log.error({ err, to, reconciled: status }, "withdraw error; reconciled");
    await recordExecution({
      userId: args.user,
      status,
      txHash,
      amountIn: amountStr,
      tokenIn: args.token,
      error: status === "confirmed" ? undefined : message,
    });
    return { status, txHash, amount: amountStr };
  }
}

interface ExecutionRow {
  userId: string;
  status: string;
  txHash?: string;
  amountIn: string;
  tokenIn: string;
  error?: string;
}

async function recordExecution(row: ExecutionRow): Promise<void> {
  const [inserted] = await db
    .insert(executions)
    .values({
      userId: row.userId,
      scheduleId: null,
      kind: "user_withdraw",
      status: row.status,
      txHash: row.txHash ?? null,
      amountIn: row.amountIn,
      tokenIn: row.tokenIn,
      feeCurrency: config.FEE_CURRENCY,
      error: row.error ?? null,
    })
    .returning();
  queueReceipt(inserted);
}

// CLI: parse --flag value pairs.
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

const invokedDirectly = process.argv[1]?.endsWith("withdraw-to-user.ts");
if (invokedDirectly) {
  withdraw(parseCliArgs(process.argv.slice(2)))
    .then(async (r) => {
      await flushReceipts();
      await pool.end();
      process.exit(r.status === "failed" ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "withdraw script failed");
      await pool.end();
      process.exit(1);
    });
}
