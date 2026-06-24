// Supply a stablecoin to Aave V3 on Celo (savings sweep). Approves the Pool if
// the allowance is short, then calls Pool.supply, paying gas in a stablecoin via
// feeCurrency. Gated by DRY_RUN and the spend caps.
//
// Run: tsx openclaw/skills/yield/scripts/supply.ts --user <id> --asset cUSD --amount 1
import { erc20Abi, getAddress, parseUnits, type Hex } from "viem";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, pool as dbPool } from "../../../../shared/db/client.js";
import { users, executions } from "../../../../shared/db/schema.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { publicClient, walletClientFor, celo } from "../../../../shared/viem.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { decryptKey } from "../../../../shared/crypto.js";
import { checkCaps } from "../../../../shared/caps.js";
import { reconcileTx } from "../../../../shared/reconcile.js";
import { resolvePool, assertApprovedAsset, aavePoolAbi } from "../../../../shared/aave.js";
import { log } from "../../../../shared/log.js";

const ArgSchema = z.object({
  user: z.string().uuid(),
  asset: z.string().min(1),
  amount: z.string().refine((a) => Number(a) > 0, "amount must be positive"),
  scheduleId: z.string().uuid().optional(),
  cycleId: z.string().uuid().optional(),
  kind: z.string().default("savings_sweep"),
});

export interface SupplyArgs {
  user: string;
  asset: string;
  amount: string;
  scheduleId?: string;
  cycleId?: string;
  kind?: string;
}

export async function supply(rawArgs: SupplyArgs): Promise<{ status: string; txHash?: string }> {
  const args = ArgSchema.parse(rawArgs);
  assertApprovedAsset(args.asset);
  const token = resolveToken(args.asset);
  const amountUnits = parseUnits(args.amount, token.decimals);
  const amountNum = Number(args.amount);
  const feeCurrency = feeCurrencyAdapter();

  const [user] = await db.select().from(users).where(eq(users.id, args.user));
  if (!user) throw new Error(`unknown user ${args.user}`);
  const owner = getAddress(user.walletAddress);

  const cap = await checkCaps(args.user, amountNum);
  if (!cap.allowed) {
    log.warn({ user: args.user, reason: cap.reason }, "supply skipped: cap breach");
    await recordRow({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "skipped_cap",
      amountIn: args.amount,
      tokenIn: args.asset,
      error: cap.reason ?? "cap breach",
    });
    return { status: "skipped_cap" };
  }

  // Balance pre-check: skip cleanly rather than burn approval gas on a revert.
  const balance = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  if (balance < amountUnits) {
    log.info({ owner, asset: args.asset, amount: args.amount }, "supply skipped: insufficient balance");
    await recordRow({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "skipped_empty",
      amountIn: args.amount,
      tokenIn: args.asset,
    });
    return { status: "skipped_empty" };
  }

  const poolAddress = await resolvePool();

  // Does the execution wallet already have enough allowance to the Pool?
  const allowance = (await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, poolAddress],
  })) as bigint;
  const needsApproval = allowance < amountUnits;

  if (config.DRY_RUN) {
    log.info(
      {
        owner,
        asset: args.asset,
        amount: args.amount,
        pool: poolAddress,
        needsApproval,
        feeCurrency,
        chainId: celo.id,
      },
      "DRY_RUN supply built, not sent",
    );
    await recordRow({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status: "dry_run",
      amountIn: args.amount,
      tokenIn: args.asset,
    });
    return { status: "dry_run" };
  }

  const pk = decryptKey(user.walletKeyRef) as Hex;
  const wallet = walletClientFor(pk);
  const account = wallet.account!;
  let txHash: string | undefined;

  try {
    if (needsApproval) {
      const approvalHash = await wallet.writeContract({
        account,
        chain: celo,
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [poolAddress, amountUnits],
        feeCurrency,
      });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
      log.info({ approvalHash, asset: args.asset }, "Aave pool allowance approved");
    }

    txHash = await wallet.writeContract({
      account,
      chain: celo,
      address: poolAddress,
      abi: aavePoolAbi,
      functionName: "supply",
      args: [token.address, amountUnits, owner, 0],
      feeCurrency,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    log.info({ txHash, status, asset: args.asset, amount: args.amount }, "supply sent");
    await recordRow({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status,
      txHash,
      amountIn: args.amount,
      tokenIn: args.asset,
    });
    return { status, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = await reconcileTx(txHash);
    log.error({ err, asset: args.asset, reconciled: status }, "supply error; reconciled");
    await recordRow({
      userId: args.user,
      scheduleId: args.scheduleId,
      cycleId: args.cycleId,
      kind: args.kind,
      status,
      txHash,
      amountIn: args.amount,
      tokenIn: args.asset,
      error: status === "confirmed" ? undefined : message,
    });
    return { status, txHash };
  }
}

interface YieldRow {
  userId: string;
  scheduleId?: string;
  cycleId?: string;
  kind: string;
  status: string;
  txHash?: string;
  amountIn: string;
  tokenIn: string;
  error?: string;
}

async function recordRow(row: YieldRow): Promise<void> {
  await db.insert(executions).values({
    userId: row.userId,
    scheduleId: row.scheduleId ?? null,
    cycleId: row.cycleId ?? null,
    kind: row.kind,
    status: row.status,
    txHash: row.txHash ?? null,
    amountIn: row.amountIn,
    tokenIn: row.tokenIn,
    feeCurrency: config.FEE_CURRENCY,
    error: row.error ?? null,
  });
}

function parseCliArgs(argv: string[]): SupplyArgs {
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
  return out as unknown as SupplyArgs;
}

const invokedDirectly = process.argv[1]?.endsWith("supply.ts");
if (invokedDirectly) {
  supply(parseCliArgs(process.argv.slice(2)))
    .then(async (r) => {
      await dbPool.end();
      process.exit(r.status === "failed" ? 1 : 0);
    })
    .catch(async (err) => {
      log.error({ err }, "supply script failed");
      await dbPool.end();
      process.exit(1);
    });
}
