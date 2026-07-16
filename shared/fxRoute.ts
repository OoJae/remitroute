// Buy a priced FX route over x402, paying as a specific agent wallet.
//
// This is what makes an x402 payment the by-product of a real decision rather
// than a traffic loop: when a fleet agent's rule actually needs to convert one
// currency into another, it first pays our x402-monetized FX route for a priced
// route, then executes on it. The payment happens because the agent needed the
// answer, at the cadence of its real rules.
//
// Settlement goes through the Celo facilitator (X402_FACILITATOR_URL), so these
// payments are counted on the hackathon x402 leaderboard. Note the payer never
// broadcasts anything: x402 on USDC is EIP-3009, so the agent only signs an
// EIP-712 TransferWithAuthorization. It needs a USDC balance and nothing else,
// no gas and no approval.
//
// Best effort BY CONTRACT: this sits in front of a money path, so every failure
// (402, 429 from the route's per-IP rate limit, a 503 when the FX market cannot
// be quoted, a timeout, a dead origin) returns null and the caller proceeds
// unpriced. It must never throw and must never block a rebalance.
import { createThirdwebClient } from "thirdweb";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { privateKeyToAccount, createWalletAdapter } from "thirdweb/wallets";
import { celo as thirdwebCelo } from "thirdweb/chains";
import { getAddress, type Hex } from "viem";
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { users } from "./db/schema.js";
import { decryptKey } from "./crypto.js";
import { config } from "./config.js";
import { log } from "./log.js";

export interface BuyRouteArgs {
  userId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
}

export interface PricedRoute {
  rate: number;
  amountOut: string;
  tokenIn: string;
  tokenOut: string;
  // The x402 settlement tx, when the facilitator returned one.
  txHash: string | null;
  payer: string;
}

// One thirdweb client for the process; the per-agent wallet adapter is cheap and
// is built per call so a key is never held longer than the request.
let cachedClient: ReturnType<typeof createThirdwebClient> | null = null;
function thirdwebClient(): ReturnType<typeof createThirdwebClient> | null {
  if (!config.THIRDWEB_CLIENT_ID) return null;
  if (!cachedClient) cachedClient = createThirdwebClient({ clientId: config.THIRDWEB_CLIENT_ID });
  return cachedClient;
}

export function fleetX402Enabled(): boolean {
  return process.env.X402_FLEET_ENABLED === "true";
}

export async function buyRoute(args: BuyRouteArgs): Promise<PricedRoute | null> {
  try {
    const client = thirdwebClient();
    if (!client) {
      log.warn("buyRoute: THIRDWEB_CLIENT_ID not set; skipping priced route");
      return null;
    }
    const [user] = await db.select().from(users).where(eq(users.id, args.userId));
    if (!user?.walletKeyRef) return null;
    // Only our own agent wallets buy routes. A real user's rebalance must never
    // spend their USDC on a quote they did not ask for.
    if (!user.isFleet) return null;

    const pk = decryptKey(user.walletKeyRef) as Hex;
    const account = privateKeyToAccount({ client, privateKey: pk });
    const wallet = createWalletAdapter({
      client,
      adaptedAccount: account,
      chain: thirdwebCelo,
      onDisconnect: () => {},
      switchChain: () => {},
    });
    // Authorize at most 1 USDC per call, far above the 0.01 price, so a
    // misconfigured price can never drain an agent.
    const fetchWithPayment = wrapFetchWithPayment(fetch, client, wallet, { maxValue: 1000000n });
    const payer = getAddress(account.address);

    const base = config.APP_BASE_URL.replace(/\/$/, "");
    const url = `${base}/api/fx-route?tokenIn=${encodeURIComponent(args.tokenIn)}&tokenOut=${encodeURIComponent(
      args.tokenOut,
    )}&amountIn=${encodeURIComponent(args.amountIn)}`;

    const res = await fetchWithPayment(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      // 402 (payment rejected), 429 (per-IP rate limit; the client sends two
      // requests per payment), 503 (no quote, and the route did not charge).
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      log.warn({ status: res.status, error: body.error, payer, pair: `${args.tokenIn}->${args.tokenOut}` }, "buyRoute: route not purchased");
      return null;
    }
    const body = (await res.json()) as { amountOut?: string; rate?: number };
    const rate = Number(body.rate ?? 0);
    if (!(rate > 0)) return null;

    log.info({ payer, pair: `${args.tokenIn}->${args.tokenOut}`, rate }, "buyRoute: priced route purchased over x402");
    return {
      rate,
      amountOut: String(body.amountOut ?? ""),
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      // The route returns the quote; the settlement hash is recorded by the route
      // itself in treasury_actions (detail.payer joins back to this agent).
      txHash: null,
      payer,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, userId: args.userId }, "buyRoute failed; proceeding unpriced");
    return null;
  }
}
