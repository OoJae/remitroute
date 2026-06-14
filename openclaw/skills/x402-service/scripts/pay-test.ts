// Real paid x402 call: a payer wallet pays the live fx-route endpoint via
// thirdweb wrapFetchWithPayment and the settlement lands onchain on Celo. Prints
// the returned Mento FX route + rate.
//
// Run: tsx openclaw/skills/x402-service/scripts/pay-test.ts --payer-key 0x.. \
//        [--tokenIn cUSD --tokenOut cKES --amountIn 1]
import { createThirdwebClient } from "thirdweb";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { privateKeyToAccount, createWalletAdapter } from "thirdweb/wallets";
import { celo } from "thirdweb/chains";
import { config } from "../../../../shared/config.js";
import { log } from "../../../../shared/log.js";

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

async function main(): Promise<void> {
  const a = parseCliArgs(process.argv.slice(2));
  const payerKey = a["payer-key"];
  if (!payerKey) throw new Error("--payer-key is required");
  if (!config.THIRDWEB_CLIENT_ID) throw new Error("THIRDWEB_CLIENT_ID not set");

  const tokenIn = a.tokenIn ?? "cUSD";
  const tokenOut = a.tokenOut ?? "cKES";
  const amountIn = a.amountIn ?? "1";

  const client = createThirdwebClient({ clientId: config.THIRDWEB_CLIENT_ID });
  const account = privateKeyToAccount({
    client,
    privateKey: payerKey.startsWith("0x") ? payerKey : `0x${payerKey}`,
  });
  // The x402 helper needs a Wallet; adapt the private-key account to one on Celo.
  const wallet = createWalletAdapter({
    client,
    adaptedAccount: account,
    chain: celo,
    onDisconnect: () => {},
    switchChain: () => {},
  });

  // Cap the payment we will authorize (base units). 1 USDC (6 decimals) ceiling.
  const fetchWithPayment = wrapFetchWithPayment(fetch, client, wallet, { maxValue: 1000000n });

  const url = `${config.APP_BASE_URL.replace(/\/$/, "")}/api/fx-route?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  log.info({ url, payer: account.address }, "paying x402 endpoint");
  const res = await fetchWithPayment(url);
  const body = await res.json().catch(() => ({}));
  log.info({ status: res.status, body }, "x402 paid response");
  process.exit(res.status === 200 ? 0 : 1);
}

main().catch((err) => {
  log.error({ err }, "pay-test failed");
  process.exit(1);
});
