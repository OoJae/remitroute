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

const MAX_CUSD = 5; // hard safety ceiling

async function main(toArg: string, amountArg: string, execute: boolean): Promise<void> {
  if (!config.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY (owner) required");
  if (!isAddress(toArg)) throw new Error("--to must be a valid address");
  const amount = Number(amountArg);
  if (!(amount > 0) || amount > MAX_CUSD) throw new Error(`--amount must be > 0 and <= ${MAX_CUSD}`);

  const token = resolveToken("cUSD");
  const to = getAddress(toArg);
  const units = parseUnits(amountArg, token.decimals);
  const pk = (config.AGENT_PRIVATE_KEY.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = walletClientFor(pk);

  log.info(
    { from: wallet.account!.address, to, amount: amountArg, token: "cUSD" },
    execute ? "funding exec wallet from owner" : "PREVIEW only; rerun with --execute",
  );
  if (!execute) return;

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
}

const argv = process.argv.slice(2);
function val(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

main(val("--to") ?? "", val("--amount") ?? "0", argv.includes("--execute"))
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, "fund-exec failed");
    process.exit(1);
  });
