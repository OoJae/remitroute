// Guardian 1 gas-floor check. Reads the treasury fee-currency balance and
// reports whether it is above the configured floor. The heartbeat stops money
// movement on a fail so the agent never strands itself without gas.
// Run: pnpm skill:check-gas
import { erc20Abi, formatUnits, getAddress } from "viem";
import { publicClient } from "../../../../shared/viem.js";
import { config } from "../../../../shared/config.js";
import { resolveToken } from "../../../../shared/addresses.js";
import { log } from "../../../../shared/log.js";

export interface GasBufferResult {
  pass: boolean;
  balance: number;
  floor: number;
  feeCurrency: string;
  treasury: string | null;
}

export async function checkGasBuffer(): Promise<GasBufferResult> {
  const feeSymbol = config.FEE_CURRENCY;
  const token = resolveToken(feeSymbol);
  const floor = config.GAS_FLOOR;

  // The treasury whose gas balance matters is the agent wallet. Without an
  // address configured we cannot read a balance, so report a fail with a clear
  // reason rather than guessing.
  const treasuryRaw = config.AGENT_WALLET_ADDRESS;
  if (!treasuryRaw) {
    log.warn(
      { feeCurrency: feeSymbol, floor },
      "no AGENT_WALLET_ADDRESS set, cannot read gas buffer",
    );
    return { pass: false, balance: 0, floor, feeCurrency: feeSymbol, treasury: null };
  }

  const treasury = getAddress(treasuryRaw);
  const raw = await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasury],
  });
  const balance = Number(formatUnits(raw, token.decimals));
  const pass = balance >= floor;

  log.info(
    { feeCurrency: feeSymbol, balance, floor, pass, treasury },
    pass ? "gas buffer ok" : "gas buffer below floor",
  );
  return { pass, balance, floor, feeCurrency: feeSymbol, treasury };
}

// Allow direct invocation as a script.
const invokedDirectly = process.argv[1]?.endsWith("check-gas-buffer.ts");
if (invokedDirectly) {
  checkGasBuffer()
    .then((r) => {
      process.exit(r.pass ? 0 : 1);
    })
    .catch((err) => {
      log.error({ err }, "check-gas-buffer failed");
      process.exit(2);
    });
}
