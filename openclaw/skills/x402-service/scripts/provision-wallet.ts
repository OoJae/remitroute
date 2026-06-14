// Provision (or reuse) a thirdweb server wallet for the x402 facilitator, using
// the secret key. Prints the address to set as SERVER_WALLET_ADDRESS. Run once.
//
// Run: tsx openclaw/skills/x402-service/scripts/provision-wallet.ts
import { Engine } from "thirdweb";
import { thirdwebServerClient } from "../../../../shared/x402.js";
import { log } from "../../../../shared/log.js";

const LABEL = "remitroute-x402";

async function main(): Promise<void> {
  const client = thirdwebServerClient();
  // Reuse an existing server wallet with our label if present.
  const existing = await Engine.getServerWallets({ client });
  const found = existing.accounts?.find((a) => a.label === LABEL);
  if (found) {
    log.info({ address: found.address, label: LABEL }, "reusing existing server wallet");
    console.log(found.address);
    return;
  }
  const created = await Engine.createServerWallet({ client, label: LABEL });
  log.info({ address: created.address, label: LABEL }, "created server wallet");
  console.log(created.address);
}

main().catch((err) => {
  log.error({ err }, "provision-wallet failed");
  process.exit(1);
});
