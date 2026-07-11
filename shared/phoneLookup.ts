// Phone number -> wallet address via Celo SocialConnect: ask ODIS for the
// privacy-preserving obfuscated identifier (our agent wallet pays the tiny
// query quota in cUSD), then read the FederatedAttestations registry for
// attestations issued by MiniPay, whose wallet-per-phone mapping this resolves.
// Server-side only (heavy legacy deps: contractkit + web3); never import from
// client code. Returns null when the phone has no MiniPay wallet.
import { erc20Abi, getAddress, type Hex } from "viem";
import { sql } from "drizzle-orm";
import { OdisUtils } from "@celo/identity";
import { AuthenticationMethod, OdisContextName } from "@celo/identity/lib/odis/query";
import { config } from "./config.js";
import { TOKENS } from "./addresses.js";
import { publicClient, walletClientFor, celo } from "./viem.js";
import { feeCurrencyAdapter } from "./feeCurrency.js";
import { attributionSuffix } from "./attribution.js";
import { reconcileTx, RECEIPT_TIMEOUT_MS } from "./reconcile.js";
import { getEngineState } from "./engine.js";
import { db } from "./db/client.js";
import { treasuryActions } from "./db/schema.js";
import { log } from "./log.js";

// MiniPay's published SocialConnect attestation issuer on Celo mainnet.
const MINIPAY_ISSUER = "0x7888612486844Bb9BE598668081c59A9f7367FBc";

// ODIS quota top-up: 0.05 cUSD buys ~50 lookups; refill only when exhausted.
const TOPUP_CUSD_WEI = "50000000000000000"; // 0.05 cUSD
const TOPUP_STRATEGY = "odis_quota_topup";

// How many top-ups have been recorded (attempted or done) in the trailing 24h.
// Counting BEFORE the pay and recording a row per attempt bounds concurrent
// cold-start isolates to at most the cap plus in-flight overshoot.
async function topupsToday(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(treasuryActions)
    .where(sql`strategy = ${TOPUP_STRATEGY} and created_at > now() - interval '24 hours'`);
  return row?.n ?? 0;
}

// contractkit is CommonJS legacy; load lazily so merely importing this module
// costs nothing and the Mini App bundle never sees it.
async function getKit() {
  const { newKit } = await import("@celo/contractkit");
  const kit = newKit(config.CELO_RPC ?? "https://forno.celo.org");
  const pk = config.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY required for phone lookup (ODIS quota)");
  kit.addAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const account = kit.getWallet()!.getAccounts()[0]! as `0x${string}`;
  kit.defaultAccount = account;
  return { kit, account };
}

async function ensureQuota(
  kit: Awaited<ReturnType<typeof getKit>>["kit"],
  account: string,
  // The ODIS query types are looser than our lint config likes; both values are
  // built in resolvePhone and passed straight through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authSigner: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceContext: any,
): Promise<void> {
  const status = await OdisUtils.Quota.getPnpQuotaStatus(account, authSigner, serviceContext);
  const remaining = (status.totalQuota ?? 0) - (status.performedQueryCount ?? 0);
  if (remaining >= 1) return;

  // This is the one place a Vercel request spends real agent-wallet cUSD, so it
  // runs under the same guardrails as the money engine: a hard daily cap
  // enforced across all isolates via the treasury ledger, and the global
  // circuit breaker. Both keep a sybil (accounts are cheap) from bleeding the
  // wallet through phone lookups.
  const engine = await getEngineState();
  if (engine.status === "halted") {
    throw new Error("engine halted; ODIS top-up refused");
  }
  const spentToday = await topupsToday();
  if (spentToday >= config.ODIS_TOPUP_MAX_PER_DAY) {
    log.warn({ spentToday, cap: config.ODIS_TOPUP_MAX_PER_DAY }, "ODIS daily top-up cap reached; refusing");
    throw new Error("ODIS daily quota-top-up cap reached; try again later");
  }

  log.info({ account, remaining, spentToday }, "ODIS quota exhausted; paying 0.05 cUSD for more");
  // contractkit only resolves the OdisPayments address; the transactions go
  // through our own viem stack, which builds cip-64 txs with gas paid in cUSD
  // (the wallet holds no CELO) and stamps the attribution suffix.
  const odisPayments = await kit.contracts.getOdisPayments();
  const odisAddress = getAddress(odisPayments.address);
  const pk = (config.AGENT_PRIVATE_KEY!.startsWith("0x")
    ? config.AGENT_PRIVATE_KEY!
    : `0x${config.AGENT_PRIVATE_KEY}`) as Hex;
  const wallet = walletClientFor(pk);
  const feeCurrency = feeCurrencyAdapter();
  const approveHash = await wallet.writeContract({
    address: TOKENS.cUSD.address,
    abi: erc20Abi,
    functionName: "approve",
    args: [odisAddress, BigInt(TOPUP_CUSD_WEI)],
    feeCurrency,
    dataSuffix: attributionSuffix(),
    account: wallet.account!,
    chain: celo,
  });
  const approveFate = await reconcileTxWithTimeout(approveHash);
  if (approveFate !== "confirmed") {
    throw new Error(`ODIS allowance tx ${approveFate}; aborting top-up`);
  }
  const payHash = await wallet.writeContract({
    address: odisAddress,
    abi: [
      {
        type: "function",
        name: "payInCUSD",
        stateMutability: "nonpayable",
        inputs: [
          { name: "account", type: "address" },
          { name: "value", type: "uint256" },
        ],
        outputs: [],
      },
    ] as const,
    functionName: "payInCUSD",
    args: [getAddress(account), BigInt(TOPUP_CUSD_WEI)],
    feeCurrency,
    dataSuffix: attributionSuffix(),
    account: wallet.account!,
    chain: celo,
  });
  const payFate = await reconcileTxWithTimeout(payHash);
  // Record the spend on the operator-visible ledger regardless of fate (a
  // broadcast that we could not confirm still may have moved cUSD, and it must
  // count toward the daily cap).
  await db
    .insert(treasuryActions)
    .values({
      strategy: TOPUP_STRATEGY,
      status: payFate,
      txHash: payHash,
      detail: { approveHash, payHash, amountCusd: "0.05", account, fate: payFate },
    })
    .catch((err) => log.warn({ err }, "could not record ODIS top-up to treasury"));
  if (payFate !== "confirmed") {
    throw new Error(`ODIS payInCUSD ${payFate}; quota may not be funded`);
  }
  log.info({ approveHash, payHash }, "ODIS quota topped up");
}

// Wait for a receipt with a bound, then resolve the true on-chain fate so a
// stuck top-up tx can never hang the serverless invocation indefinitely.
async function reconcileTxWithTimeout(hash: Hex): Promise<string> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    return receipt.status === "success" ? "confirmed" : "reverted";
  } catch {
    return reconcileTx(hash);
  }
}

// Resolve an E.164 phone number to the MiniPay wallet that attested it, or
// null when none exists. Throws on infrastructure failures (ODIS down, quota
// unpayable) so callers can distinguish "not found" from "try again".
export async function resolvePhone(phoneE164: string): Promise<string | null> {
  const { kit, account } = await getKit();
  const authSigner = {
    authenticationMethod: AuthenticationMethod.WALLET_KEY,
    contractKit: kit,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serviceContext = OdisUtils.Query.getServiceContext(OdisContextName.MAINNET) as any;

  await ensureQuota(kit, account, authSigner, serviceContext);

  const { obfuscatedIdentifier } = await OdisUtils.Identifier.getObfuscatedIdentifier(
    phoneE164,
    OdisUtils.Identifier.IdentifierPrefix.PHONE_NUMBER,
    account,
    authSigner,
    serviceContext,
  );

  const federated = await kit.contracts.getFederatedAttestations();
  const result = await federated.lookupAttestations(obfuscatedIdentifier, [MINIPAY_ISSUER]);
  const address = result.accounts?.[0];
  return address && address !== "0x0000000000000000000000000000000000000000" ? address : null;
}
