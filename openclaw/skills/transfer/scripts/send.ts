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
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users, executions, recipients } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { walletClientFor, publicClient, celo } from "../../../../shared/viem.js";
import { decryptKey } from "../../../../shared/crypto.js";
import { checkCaps } from "../../../../shared/caps.js";
import { usdValueOf } from "../../../../shared/usdValue.js";
import { reconcileTx, RECEIPT_TIMEOUT_MS } from "../../../../shared/reconcile.js";
import { reserveIntent, finalizeExecution } from "../../../../shared/execLedger.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { queueReceipt, flushReceipts } from "../../../../shared/receipts.js";
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
  // Deterministic idempotency key; when set, the broadcast is reserved first.
  intentId: z.string().optional(),
  rationale: z.string().optional(),
});

export interface SendArgs {
  user: string;
  to: string;
  amount: string;
  token: string;
  kind?: "remittance" | "bill_drip";
  scheduleId?: string;
  cycleId?: string;
  intentId?: string;
  // Why this transfer fired, captured by the caller at decision time.
  rationale?: string;
}

export async function send(rawArgs: SendArgs): Promise<{ status: string; txHash?: string }> {
  const args = ArgSchema.parse(rawArgs);
  const token = resolveToken(args.token);
  const recipient = getAddress(args.to);
  const amountUnits = parseUnits(args.amount, token.decimals);
  const feeCurrency = feeCurrencyAdapter();

  // Resolve the funding sub-wallet for this user.
  const [user] = await db.select().from(users).where(eq(users.id, args.user));
  if (!user) throw new Error(`unknown user ${args.user}`);

  // Recipient allowlist (user-to-user transfers only). A remittance/bill_drip may
  // only pay an address the user confirmed through the authenticated schedule
  // create flow (recipients table); an unknown recipient is skipped, never paid,
  // so a corrupted or tampered schedule row cannot misdirect funds. dca, savings,
  // and withdraw are not user-to-user transfers and are exempt.
  if (args.kind === "remittance" || args.kind === "bill_drip") {
    const [allowed] = await db
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(eq(recipients.userId, args.user), sql`lower(${recipients.address}) = lower(${args.to})`))
      .limit(1);
    if (!allowed) {
      log.warn({ user: args.user, to: recipient }, "transfer skipped: recipient not on allowlist");
      await recordExecution({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        kind: args.kind,
        status: "skipped_no_recipient",
        amountIn: args.amount,
        tokenIn: args.token,
        // On a skip the useful reason is why the money did NOT move.
        rationale: "recipient is not on this user's allowlist, so the transfer was not sent",
        feeCurrency: config.FEE_CURRENCY,
        error: "recipient not on user allowlist",
      });
      return { status: "skipped_no_recipient" };
    }
  }

  // Value the leg in USD so caps (which are USD-denominated) compare correctly
  // for non-1:1 tokens, and record that value on the ledger row.
  const usd = await usdValueOf(args.token, args.amount);

  // Caps first. Skip and log if a cap would be breached.
  const cap = await checkCaps(args.user, usd);
  if (!cap.allowed) {
    log.warn({ user: args.user, reason: cap.reason }, "transfer skipped: cap breach");
    await recordExecution({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "skipped_cap",
      amountIn: args.amount,
      usdValue: usd,
      tokenIn: args.token,
      rationale: cap.reason ?? "a spend cap was reached, so the transfer was not sent",
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
      usdValue: usd,
      tokenIn: args.token,
        rationale: args.rationale,
      feeCurrency: config.FEE_CURRENCY,
    });
    return { status: "dry_run" };
  }

  // Reserve the intent BEFORE broadcasting so a crash-then-reclaim re-run of this
  // schedule slot cannot double-send: if the intent is already reserved, skip.
  let pendingId: string | undefined;
  if (args.intentId) {
    const id = await reserveIntent({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      intentId: args.intentId,
      kind: args.kind,
      amountIn: args.amount,
      usdValue: usd,
      tokenIn: args.token,
      rationale: args.rationale,
    });
    if (id === null) {
      log.warn({ intentId: args.intentId, scheduleId: args.scheduleId }, "intent already reserved; skipping duplicate transfer");
      return { status: "skipped_duplicate" };
    }
    pendingId = id;
  }

  // Real send. Decrypt the user sub-wallet key, send through fee abstraction.
  const pk = decryptKey(user.walletKeyRef) as Hex;
  const wallet = walletClientFor(pk);
  let txHash: string | undefined;
  try {
    txHash = await wallet.writeContract({ ...txRequest, account: wallet.account!, chain: celo, dataSuffix: attributionSuffix() });
    log.info({ txHash, to: recipient, amount: args.amount }, "transfer sent");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: RECEIPT_TIMEOUT_MS });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    if (pendingId) {
      await finalizeExecution(pendingId, { status, txHash });
    } else {
      await recordExecution({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        kind: args.kind,
        status,
        txHash,
        amountIn: args.amount,
        usdValue: usd,
        tokenIn: args.token,
        rationale: args.rationale,
        feeCurrency: config.FEE_CURRENCY,
      });
    }
    return { status, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Reconcile on chain: if the tx was broadcast it may have mined despite this
    // error, so we never blindly mark it failed (which would let it be retried
    // and double-send). Only a never-broadcast error yields a retriable "failed".
    const status = await reconcileTx(txHash);
    log.error({ err, to: recipient, reconciled: status }, "transfer error; reconciled");
    if (pendingId) {
      await finalizeExecution(pendingId, { status, txHash, error: status === "confirmed" ? undefined : message });
    } else {
      await recordExecution({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        kind: args.kind,
        status,
        txHash,
        amountIn: args.amount,
        usdValue: usd,
        tokenIn: args.token,
        rationale: args.rationale,
        feeCurrency: config.FEE_CURRENCY,
        error: status === "confirmed" ? undefined : message,
      });
    }
    return { status, txHash };
  }
}

interface ExecutionRow {
  rationale?: string;
  userId: string;
  scheduleId?: string;
  cycleId?: string;
  kind: string;
  status: string;
  txHash?: string;
  amountIn: string;
  usdValue?: number;
  tokenIn: string;
  feeCurrency: string;
  error?: string;
}

async function recordExecution(row: ExecutionRow): Promise<void> {
  const [inserted] = await db
    .insert(executions)
    .values({
      userId: row.userId,
      scheduleId: row.scheduleId ?? null,
      cycleId: row.cycleId ?? null,
      kind: row.kind,
      status: row.status,
      txHash: row.txHash ?? null,
      amountIn: row.amountIn,
      usdValue: row.usdValue != null ? row.usdValue.toString() : null,
      tokenIn: row.tokenIn,
      feeCurrency: row.feeCurrency,
      error: row.error ?? null,
      rationale: row.rationale ?? null,
    })
    .returning();
  queueReceipt(inserted);
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
      await flushReceipts();
      await pool.end();
      process.exit(r.status === "failed" ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "send script failed");
      await pool.end();
      process.exit(1);
    });
}
