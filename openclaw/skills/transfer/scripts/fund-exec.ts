// One-off: fund a user execution wallet with cUSD from the agent OWNER wallet,
// to seed activity schedules. Real money on mainnet, so it is hard-capped and
// preview-by-default (pass --execute to send). Gas is paid in cUSD (fee
// abstraction). Reuses the same transfer path as send.ts.
//
//   tsx fund-exec.ts --to 0x... --amount 3            (preview)
//   tsx fund-exec.ts --to 0x... --amount 3 --execute  (send)
import { erc20Abi, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { feeCurrencyAdapter } from "../../../../shared/feeCurrency.js";
import { walletClientFor, publicClient, celo } from "../../../../shared/viem.js";
import { attributionSuffix } from "../../../../shared/attribution.js";
import { log } from "../../../../shared/log.js";

// Per-transfer safety ceiling. Env-configurable so fleet provisioning can seed a
// larger float in one call, but it still refuses an unbounded transfer.
const maxCusd = (): number => Number(process.env.FLEET_FUND_MAX_CUSD ?? 5);

export interface FundExecArgs {
  to: string;
  amount: string;
  execute?: boolean;
  // Defaults to cUSD. x402 payers need USDC, since x402Price() is denominated in
  // USDC (it is the Celo stable with a standard EIP-3009 permit domain).
  token?: string;
}

// Transfer cUSD from the agent OWNER wallet to an execution wallet. Exported so
// provision-fleet.ts can seed a whole fleet through the same guarded path rather
// than reimplementing a raw transfer. Gas is paid in cUSD and the transfer carries
// the attribution suffix. Returns the tx hash, or null on a preview.
export async function fundExec(args: FundExecArgs): Promise<string | null> {
  if (!config.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY (owner) required");
  if (!isAddress(args.to)) throw new Error("--to must be a valid address");
  const ceiling = maxCusd();
  const amount = Number(args.amount);
  if (!(amount > 0) || amount > ceiling) throw new Error(`--amount must be > 0 and <= ${ceiling}`);

  const token = resolveToken(args.token ?? "cUSD");
  const to = getAddress(args.to);
  const units = parseUnits(args.amount, token.decimals);
  const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = walletClientFor(pk);

  log.info(
    { from: wallet.account!.address, to, amount: args.amount, token: args.token ?? "cUSD" },
    args.execute ? "funding exec wallet from owner" : "PREVIEW only; rerun with --execute",
  );
  if (!args.execute) return null;

  const hash = await wallet.writeContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, units],
    feeCurrency: feeCurrencyAdapter(),
    dataSuffix: attributionSuffix(),
    account: wallet.account!,
    chain: celo,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
  log.info({ hash, status: receipt.status }, "funded exec wallet");
  return hash;
}

async function main(toArg: string, amountArg: string, execute: boolean): Promise<void> {
  await fundExec({ to: toArg, amount: amountArg, execute });
}

const argv = process.argv.slice(2);
function val(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Only run the CLI when invoked directly. provision-fleet.ts imports fundExec, and
// without this guard that import would fire the CLI and exit the process.
const invokedDirectly = process.argv[1]?.endsWith("fund-exec.ts");
if (invokedDirectly) {
  main(val("--to") ?? "", val("--amount") ?? "0", argv.includes("--execute"))
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err }, "fund-exec failed");
      process.exit(1);
    });
}
