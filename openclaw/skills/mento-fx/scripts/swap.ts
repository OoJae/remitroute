// Mento FX swap. Quotes through the Mento SDK, builds the swap transaction, and
// executes it through viem with feeCurrency set so gas is paid in a stablecoin.
// Powers dca (swap a fixed stablecoin amount into a target asset) and the legs
// of fx_rebalance. Always enforces amountOutMin (slippage protection) with a
// defensive floor check, and never swaps without it.
//
// Run: tsx openclaw/skills/mento-fx/scripts/swap.ts --user <id> --tokenIn cUSD --tokenOut cKES --amountIn 1 --slippageBps 50
import { formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users, executions } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { publicClient, walletClientFor, celo } from "../../../../shared/viem.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { decryptKey } from "../../../../shared/crypto.js";
import { checkCaps } from "../../../../shared/caps.js";
import { usdValueOf } from "../../../../shared/usdValue.js";
import { reconcileTx, RECEIPT_TIMEOUT_MS } from "../../../../shared/reconcile.js";
import { reserveIntent, finalizeExecution } from "../../../../shared/execLedger.js";
import { getMento, resolveMentoToken } from "../../../../shared/mento.js";
import { withAttribution } from "../../../../shared/attribution.js";
import { emitReceipt } from "../../../../shared/receipts.js";
import { log } from "../../../../shared/log.js";

// Maximum slippage we ever allow, regardless of requested value.
const MAX_SLIPPAGE_BPS = 300;

const ArgSchema = z.object({
  user: z.string().uuid(),
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  amountIn: z.string().refine((a) => Number(a) > 0, "amountIn must be positive"),
  slippageBps: z.coerce.number().int().min(1).max(MAX_SLIPPAGE_BPS).default(50),
  kind: z.enum(["dca", "fx_rebalance"]).default("dca"),
  scheduleId: z.string().uuid().optional(),
  cycleId: z.string().uuid().optional(),
  intentId: z.string().optional(),
});

export interface SwapArgs {
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps?: number;
  kind?: "dca" | "fx_rebalance";
  scheduleId?: string;
  cycleId?: string;
  intentId?: string;
}

export async function swap(rawArgs: SwapArgs): Promise<{ status: string; txHash?: string }> {
  const args = ArgSchema.parse(rawArgs);
  const mento = await getMento();

  const tokenIn = await resolveMentoToken(args.tokenIn, mento);
  const tokenOut = await resolveMentoToken(args.tokenOut, mento);
  const amountInUnits = parseUnits(args.amountIn, tokenIn.decimals);

  const [user] = await db.select().from(users).where(eq(users.id, args.user));
  if (!user) throw new Error(`unknown user ${args.user}`);

  // Value the spent leg (tokenIn) in USD so the USD-denominated caps compare
  // correctly for non-1:1 tokens, and record that value on the ledger row.
  const usd = await usdValueOf(args.tokenIn, args.amountIn);

  // Caps first.
  const cap = await checkCaps(args.user, usd);
  if (!cap.allowed) {
    log.warn({ user: args.user, reason: cap.reason }, "swap skipped: cap breach");
    await recordSwap({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "skipped_cap",
      amountIn: args.amountIn,
      usdValue: usd,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      error: cap.reason ?? "cap breach",
    });
    return { status: "skipped_cap" };
  }

  // Quote and build the swap. buildSwapTransaction returns the approval call (if
  // needed) plus the swap call params and the SDK-computed amountOutMin.
  const quote = await mento.quotes.getAmountOut(tokenIn.address, tokenOut.address, amountInUnits);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const built = await mento.swap.buildSwapTransaction(
    tokenIn.address,
    tokenOut.address,
    amountInUnits,
    getAddress(user.walletAddress),
    getAddress(user.walletAddress),
    // The SDK expects slippageTolerance as a percent (0.5 = 0.5 percent), capped
    // at 20 percent. 50 bps becomes 0.5. Our MAX_SLIPPAGE_BPS floor still applies.
    { slippageTolerance: args.slippageBps / 100, deadline },
  );
  const amountOutMin = built.swap.amountOutMin;
  const expectedOut = built.swap.expectedAmountOut;

  // Defensive slippage floor: regardless of how the SDK interprets the tolerance,
  // amountOutMin must not fall below quote minus the max allowed slippage.
  const floor = (quote * BigInt(10000 - MAX_SLIPPAGE_BPS)) / 10000n;
  if (amountOutMin <= 0n || amountOutMin < floor) {
    throw new Error(
      `amountOutMin ${amountOutMin} below safe floor ${floor} (quote ${quote}); refusing swap`,
    );
  }

  const feeCurrency = feeCurrencyAdapter();
  const outFormatted = formatUnits(expectedOut, tokenOut.decimals);

  if (config.DRY_RUN) {
    log.info(
      {
        from: user.walletAddress,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        quote: formatUnits(quote, tokenOut.decimals),
        amountOutMin: formatUnits(amountOutMin, tokenOut.decimals),
        expectedOut: outFormatted,
        needsApproval: built.approval !== null,
        swapTo: built.swap.params.to,
        feeCurrency,
        chainId: celo.id,
      },
      "DRY_RUN swap built, not sent",
    );
    await recordSwap({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "dry_run",
      amountIn: args.amountIn,
      usdValue: usd,
      tokenIn: args.tokenIn,
      amountOut: outFormatted,
      tokenOut: args.tokenOut,
    });
    return { status: "dry_run" };
  }

  // Reserve the intent before broadcasting so a crash-then-reclaim re-run cannot
  // double-swap this leg.
  let pendingId: string | undefined;
  if (args.intentId) {
    const id = await reserveIntent({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      intentId: args.intentId,
      kind: args.kind,
      amountIn: args.amountIn,
      usdValue: usd,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
    });
    if (id === null) {
      log.warn({ intentId: args.intentId, scheduleId: args.scheduleId }, "intent already reserved; skipping duplicate swap");
      return { status: "skipped_duplicate" };
    }
    pendingId = id;
  }

  // Real execution. Approve first if required, then swap. Both pay gas in stablecoin.
  const pk = decryptKey(user.walletKeyRef) as Hex;
  const wallet = walletClientFor(pk);
  const account = wallet.account!;
  let txHash: string | undefined;

  try {
    if (built.approval) {
      const approvalHash = await wallet.sendTransaction({
        account,
        chain: celo,
        to: getAddress(built.approval.to),
        data: withAttribution(built.approval.data as Hex),
        feeCurrency,
      });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
      log.info({ approvalHash }, "swap allowance approved");
    }

    txHash = await wallet.sendTransaction({
      account,
      chain: celo,
      to: getAddress(built.swap.params.to),
      data: withAttribution(built.swap.params.data as Hex),
      feeCurrency,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: RECEIPT_TIMEOUT_MS });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    log.info({ txHash, status, tokenIn: args.tokenIn, tokenOut: args.tokenOut }, "swap sent");
    if (pendingId) {
      await finalizeExecution(pendingId, { status, txHash, amountOut: outFormatted });
    } else {
      await recordSwap({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        kind: args.kind,
        status,
        txHash,
        amountIn: args.amountIn,
        usdValue: usd,
        tokenIn: args.tokenIn,
        amountOut: outFormatted,
        tokenOut: args.tokenOut,
      });
    }
    return { status, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = await reconcileTx(txHash);
    log.error(
      { err, tokenIn: args.tokenIn, tokenOut: args.tokenOut, reconciled: status },
      "swap error; reconciled",
    );
    if (pendingId) {
      await finalizeExecution(pendingId, { status, txHash, error: status === "confirmed" ? undefined : message });
    } else {
      await recordSwap({
        userId: args.user,
        scheduleId: args.scheduleId,
        cycleId: args.cycleId,
        kind: args.kind,
        status,
        txHash,
        amountIn: args.amountIn,
        usdValue: usd,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        error: status === "confirmed" ? undefined : message,
      });
    }
    return { status, txHash };
  }
}

interface SwapRow {
  userId: string;
  scheduleId?: string;
  cycleId?: string;
  kind: string;
  status: string;
  txHash?: string;
  amountIn: string;
  usdValue?: number;
  tokenIn: string;
  amountOut?: string;
  tokenOut: string;
  error?: string;
}

async function recordSwap(row: SwapRow): Promise<void> {
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
      amountOut: row.amountOut ?? null,
      tokenOut: row.tokenOut,
      feeCurrency: config.FEE_CURRENCY,
      error: row.error ?? null,
    })
    .returning();
  await emitReceipt(inserted);
}

function parseCliArgs(argv: string[]): SwapArgs {
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
  return out as unknown as SwapArgs;
}

const invokedDirectly = process.argv[1]?.endsWith("swap.ts");
if (invokedDirectly) {
  swap(parseCliArgs(process.argv.slice(2)))
    .then(async (r) => {
      await pool.end();
      process.exit(r.status === "failed" ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "swap script failed");
      await pool.end();
      process.exit(1);
    });
}
