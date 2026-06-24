// Self-hosted x402 facilitator for the paid FX-route endpoint. We settle the
// payer's signed EIP-3009 authorization ourselves on Celo (gas paid in cUSD via
// fee abstraction); payments are received at the payTo address (the agent owner
// wallet).
import { getAddress, parseSignature, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { and, eq } from "drizzle-orm";
import { config } from "./config.js";
import { TOKENS } from "./addresses.js";
import { publicClient, walletClientFor } from "./viem.js";
import { feeCurrencyAdapter } from "./feeCurrency.js";
import { db } from "./db/client.js";
import { x402Nonces } from "./db/schema.js";
import { log } from "./log.js";

// Tolerance (seconds) when checking the authorization's validity window.
const CLOCK_SKEW_S = 120;

// Where x402 revenue is received: explicit X402_PAYTO, else the agent owner wallet.
export function x402PayTo(): string {
  const to = config.X402_PAYTO ?? config.AGENT_WALLET_ADDRESS;
  if (!to) throw new Error("no x402 payTo (set X402_PAYTO or AGENT_WALLET_ADDRESS)");
  return to;
}

// The price as a specific ERC20 amount in USDC, the x402 standard token (USDC on
// Celo supports EIP-3009 transferWithAuthorization, which the facilitator settles
// reliably; the Mento stables use a non-standard permit domain). X402_PRICE like
// "$0.01" maps to 0.01 USDC here.
export function x402Price(): { amount: string; asset: { address: `0x${string}`; decimals: number } } {
  const amountStr = config.X402_PRICE.replace(/[^0-9.]/g, "") || "0.01";
  return {
    amount: parseUnits(amountStr, TOKENS.USDC.decimals).toString(),
    asset: { address: TOKENS.USDC.address, decimals: TOKENS.USDC.decimals },
  };
}

// USDC EIP-3009 transferWithAuthorization (v,r,s variant). Anyone holding gas can
// submit the payer's signed authorization, which moves `value` from -> to.
const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

// Self-hosted x402 facilitator. thirdweb's hosted facilitator settles through a
// gasless mainnet paymaster that needs billing enabled; instead we settle the
// EIP-3009 authorization ourselves: the agent relayer submits the payer's signed
// transferWithAuthorization, paying gas in cUSD (Celo fee abstraction). The payer
// signs a direct transfer to payTo (the owner wallet), so no forwarding is needed.
export interface SettlementInfo {
  transaction: string;
  payer: string;
  value: string;
}

export function localFacilitator() {
  // Dedicated, minimally-funded relayer so an attacker forcing settlements
  // cannot drain the engine's gas wallet. Falls back to the agent key if unset.
  const relayerKey = config.RELAYER_PRIVATE_KEY ?? config.AGENT_PRIVATE_KEY;
  if (!relayerKey) {
    throw new Error("RELAYER_PRIVATE_KEY (or AGENT_PRIVATE_KEY) not set; the x402 relayer cannot settle");
  }
  const relayerHex = (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`;
  // Captures the real settled (txHash, payer, value) so the caller can record it.
  const state: { last: SettlementInfo | null } = { last: null };

  // Build the 402 payment requirements settlePayment advertises to callers.
  // payTo is the owner wallet, asset is USDC, and extra carries USDC's EIP-712
  // domain so the caller signs a TransferWithAuthorization we can submit verbatim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function accepts(args: any) {
    const price = args.price as { amount: string; asset: { address: string; decimals: number } };
    const requirement = {
      scheme: "exact",
      network: "eip155:42220",
      maxAmountRequired: String(price.amount),
      resource: args.resourceUrl,
      description: args.routeConfig?.description ?? "",
      mimeType: args.routeConfig?.mimeType ?? "application/json",
      payTo: x402PayTo(),
      maxTimeoutSeconds: 86400,
      asset: price.asset.address,
      outputSchema: { input: { type: "http", method: args.method ?? "GET", discoverable: true } },
      extra: { name: "USDC", version: "2", primaryType: "TransferWithAuthorization" },
    };
    return {
      status: 402 as const,
      responseHeaders: { "Content-Type": "application/json" },
      responseBody: { x402Version: 2, error: "Payment required", accepts: [requirement] },
    };
  }

  // Submit the caller's signed EIP-3009 authorization on Celo, gas paid in cUSD.
  // ALL economic checks run before any broadcast: an attacker cannot get a free
  // quote with a worthless/self/expired/replayed authorization, and a junk auth
  // never costs the relayer gas (we pre-simulate). The USDC contract also
  // enforces signer == from and single-use nonces onchain; these checks just make
  // the failure free and explicit.
  const network = "eip155:42220";
  const fail = (reason: string, message: string, payer = "", transaction = "") => ({
    success: false as const,
    errorReason: reason,
    errorMessage: message,
    network,
    transaction,
    payer,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function settle(payload: any, requirements: any) {
    const auth = payload?.payload?.authorization;
    const signature = payload?.payload?.signature as `0x${string}` | undefined;
    if (!auth || !signature) return fail("invalid_payload", "missing authorization or signature");

    // 1. Economic validation (no broadcast, no gas).
    let payTo: string;
    let to: string;
    let from: string;
    try {
      payTo = getAddress(x402PayTo());
      to = getAddress(auth.to);
      from = getAddress(auth.from);
    } catch {
      return fail("bad_address", "authorization addresses are malformed");
    }
    if (to !== payTo) {
      return fail("wrong_destination", `auth.to ${to} is not the required payTo ${payTo}`, from);
    }
    let value: bigint;
    try {
      value = BigInt(auth.value);
    } catch {
      return fail("bad_value", "authorization value is not an integer", from);
    }
    const required = BigInt(requirements?.maxAmountRequired ?? x402Price().amount);
    if (value < required) {
      return fail("underpaid", `authorized ${value} is below the required ${required}`, from);
    }
    const now = Math.floor(Date.now() / 1000);
    const validAfter = Number(auth.validAfter);
    const validBefore = Number(auth.validBefore);
    if (!(validAfter <= now + CLOCK_SKEW_S && validBefore >= now - CLOCK_SKEW_S)) {
      return fail("outside_validity_window", "authorization is not currently valid", from);
    }

    // 2. Replay reservation: a (payer, nonce) may settle at most once. Unique
    // index makes this atomic; a conflict means the authorization was used.
    const payerKey = from.toLowerCase();
    const nonceKey = String(auth.nonce).toLowerCase();
    const reserved = await db
      .insert(x402Nonces)
      .values({ payer: payerKey, nonce: nonceKey })
      .onConflictDoNothing()
      .returning();
    if (reserved.length === 0) {
      return fail("replayed_nonce", "this authorization nonce was already used", from);
    }

    try {
      const { r, s, v, yParity } = parseSignature(signature);
      const vNum = v !== undefined ? Number(v) : yParity + 27;
      const account = privateKeyToAccount(relayerHex);
      const callArgs = {
        address: TOKENS.USDC.address,
        abi: TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: "transferWithAuthorization" as const,
        args: [
          getAddress(auth.from),
          getAddress(auth.to),
          value,
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce as `0x${string}`,
          vNum,
          r,
          s,
        ] as const,
        account,
      };

      // 3. Pre-simulate so a bad signature / insufficient balance never costs gas.
      await publicClient.simulateContract(callArgs);

      // 4. Broadcast (gas in cUSD via fee abstraction).
      const wallet = walletClientFor(relayerHex);
      const hash = await wallet.writeContract({ ...callArgs, feeCurrency: feeCurrencyAdapter() });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        // Keep the nonce reserved (the payer must re-sign with a fresh nonce).
        return fail("settlement_reverted", `tx ${hash} reverted`, from, hash);
      }
      await db
        .update(x402Nonces)
        .set({ txHash: hash })
        .where(and(eq(x402Nonces.payer, payerKey), eq(x402Nonces.nonce, nonceKey)));
      state.last = { transaction: hash, payer: from, value: value.toString() };
      log.info({ hash, payer: from, to, value: value.toString() }, "x402 settled onchain");
      return { success: true as const, transaction: hash, network, payer: from };
    } catch (err) {
      // Never broadcast (simulate threw or an RPC error): release the nonce so a
      // transient failure can be retried with the same authorization.
      await db
        .delete(x402Nonces)
        .where(and(eq(x402Nonces.payer, payerKey), eq(x402Nonces.nonce, nonceKey)))
        .catch(() => {});
      return fail("settlement_error", (err as Error).message, from);
    }
  }

  // Only accepts + settle are exercised by settlePayment; state exposes the last
  // settlement so the route can record the real txHash/payer/value. settlePayment
  // types the facilitator more broadly than we implement, so we widen to any
  // here (the route relies on accepts/settle/settlement only).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fac = { accepts, settle, settlement: state } as any;
  return fac;
}
