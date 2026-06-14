// thirdweb client + x402 facilitator for the paid FX-route endpoint. The
// facilitator settles payments gaslessly (EIP-7702) using a thirdweb server
// wallet; payments are received at the payTo address (the agent owner wallet).
import { parseSignature, parseUnits } from "viem";
import { createThirdwebClient } from "thirdweb";
import { facilitator } from "thirdweb/x402";
import { config } from "./config.js";
import { TOKENS } from "./addresses.js";
import { publicClient, walletClientFor } from "./viem.js";
import { feeCurrencyAdapter } from "./feeCurrency.js";
import { log } from "./log.js";

// Server-side client (secret key). Throws clearly if x402 is not configured.
export function thirdwebServerClient() {
  if (!config.THIRDWEB_SECRET_KEY) {
    throw new Error("THIRDWEB_SECRET_KEY not set; x402 endpoint is not configured");
  }
  return createThirdwebClient({ secretKey: config.THIRDWEB_SECRET_KEY });
}

// The thirdweb x402 facilitator bound to our server wallet.
export function x402Facilitator() {
  if (!config.SERVER_WALLET_ADDRESS) {
    throw new Error("SERVER_WALLET_ADDRESS not set; provision a thirdweb server wallet first");
  }
  return facilitator({
    client: thirdwebServerClient(),
    serverWalletAddress: config.SERVER_WALLET_ADDRESS,
  });
}

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
export function localFacilitator() {
  const relayerKey = config.AGENT_PRIVATE_KEY;
  if (!relayerKey) {
    throw new Error("AGENT_PRIVATE_KEY not set; the x402 relayer cannot settle");
  }
  const relayerHex = (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function settle(payload: any, requirements: any) {
    const auth = payload?.payload?.authorization;
    const signature = payload?.payload?.signature as `0x${string}` | undefined;
    if (!auth || !signature) {
      return { success: false, errorReason: "invalid_payload", errorMessage: "missing authorization or signature", network: requirements?.network ?? "eip155:42220", transaction: "", payer: "" };
    }
    try {
      const { r, s, v, yParity } = parseSignature(signature);
      const vNum = v !== undefined ? Number(v) : yParity + 27;
      const wallet = walletClientFor(relayerHex);
      const hash = await wallet.writeContract({
        address: TOKENS.USDC.address,
        abi: TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          vNum,
          r,
          s,
        ],
        feeCurrency: feeCurrencyAdapter(),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { success: false, errorReason: "settlement_reverted", errorMessage: `tx ${hash} reverted`, network: requirements?.network ?? "eip155:42220", transaction: hash, payer: auth.from };
      }
      log.info({ hash, payer: auth.from, to: auth.to, value: auth.value }, "x402 settled onchain");
      return { success: true, transaction: hash, network: requirements?.network ?? "eip155:42220", payer: auth.from };
    } catch (err) {
      return { success: false, errorReason: "settlement_error", errorMessage: (err as Error).message, network: requirements?.network ?? "eip155:42220", transaction: "", payer: auth?.from ?? "" };
    }
  }

  // Only accepts + settle are exercised by settlePayment; the rest satisfy the type.
  return { accepts, settle } as unknown as ReturnType<typeof x402Facilitator>;
}
