// x402 paid FX-route API. Other agents pay a small per-call fee and receive an
// optimal Mento FX route and live rate. Payment is settled onchain on Celo via
// the thirdweb facilitator; the FX quote is a real Mento SDK quote.
import { formatUnits, parseUnits } from "viem";
import { settlePayment } from "thirdweb/x402";
import { celo } from "thirdweb/chains";
import { config } from "../../../shared/config.js";
import { paymentFacilitator, x402PayTo, x402Price } from "../../../shared/x402.js";
import { getMento, resolveMentoToken } from "../../../shared/mento.js";
import { db } from "../../../shared/db/client.js";
import { treasuryActions } from "../../../shared/db/schema.js";
import { rateLimit, clientIp } from "../../../shared/ratelimit.js";
import { log } from "../../../shared/log.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESOURCE_URL = `${config.APP_BASE_URL.replace(/\/$/, "")}/api/fx-route`;

export async function GET(request: Request) {
  // Master switch: when disabled the paid API cannot be abused or settle.
  if (!config.X402_ENABLED) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  // Rate limit per IP before any quote or settlement, so an attacker cannot
  // force unbounded relayer gas / RPC work even with valid-looking payments.
  const rl = await rateLimit(`fx-route:${clientIp(request)}`, { max: 30, windowSec: 60 });
  if (!rl.allowed) return Response.json({ error: "rate limited" }, { status: 429 });

  const url = new URL(request.url);
  const tokenIn = url.searchParams.get("tokenIn") ?? "cUSD";
  const tokenOut = url.searchParams.get("tokenOut") ?? "cKES";
  const amountIn = url.searchParams.get("amountIn") ?? "1";

  const paymentData =
    request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT");

  // When the caller has paid, compute the real Mento quote FIRST, before settling.
  // Settlement is irreversible, so we never charge for a quote we cannot deliver
  // (for example when a Mento FX market is closed outside trading hours).
  let fx: { amountOut: string; rate: number } | null = null;
  if (paymentData) {
    try {
      const mento = await getMento();
      const inTok = await resolveMentoToken(tokenIn, mento);
      const outTok = await resolveMentoToken(tokenOut, mento);
      const amountInUnits = parseUnits(amountIn, inTok.decimals);
      const quote = await mento.quotes.getAmountOut(inTok.address, outTok.address, amountInUnits);
      const amountOut = formatUnits(quote, outTok.decimals);
      fx = { amountOut, rate: Number(amountOut) / Number(amountIn) };
    } catch (err) {
      log.warn({ err, tokenIn, tokenOut }, "fx quote unavailable; not charging the caller");
      return Response.json(
        {
          error: "FX quote unavailable for this pair right now (the Mento market may be closed); you were not charged",
          detail: (err as Error).message,
          tokenIn,
          tokenOut,
        },
        { status: 503 },
      );
    }
  }

  // Settle the payment (returns 402 with requirements when unpaid; on a paid and
  // valid request, submits the caller's EIP-3009 authorization onchain on Celo
  // after our pre-broadcast economic validation in localFacilitator.settle).
  const fac = paymentFacilitator();
  let result;
  try {
    result = await settlePayment({
      resourceUrl: RESOURCE_URL,
      method: "GET",
      paymentData,
      payTo: x402PayTo(),
      network: celo,
      price: x402Price(),
      facilitator: fac,
      routeConfig: {
        description: "RemitRoute optimal Mento FX route and live rate",
        mimeType: "application/json",
      },
    });
  } catch (err) {
    log.error({ err }, "x402 settlePayment failed");
    return Response.json({ error: "x402 not configured" }, { status: 500 });
  }

  // Not paid (or settlement failed): return the 402 payment-required response.
  if (result.status !== 200) {
    return Response.json(result.responseBody, {
      status: result.status,
      headers: result.responseHeaders,
    });
  }

  // A 200 only happens for a paid request, where the quote was computed above.
  if (!fx) {
    return Response.json({ error: "settled but no quote" }, { status: 500 });
  }

  // Paid, settled, and quoted: log the activity with the REAL settled tx, payer,
  // and value (not just the advertised price) so reconcile can verify revenue.
  const settled = (fac as unknown as { settlement: { last: { transaction: string; payer: string; value: string } | null } }).settlement.last;
  await db.insert(treasuryActions).values({
    strategy: "x402_payment",
    status: "confirmed",
    txHash: settled?.transaction ?? null,
    detail: {
      resource: "fx-route",
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: fx.amountOut,
      rate: fx.rate,
      payTo: x402PayTo(),
      price: config.X402_PRICE,
      settledValue: settled?.value ?? null,
      payer: settled?.payer ?? null,
    },
  });

  return Response.json(
    {
      route: "mento",
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: fx.amountOut,
      rate: fx.rate,
      broker: "0x777B8E2F5F356c5c284342aFbF009D6552450d69",
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: result.responseHeaders },
  );
}
