// USD-equivalent valuation of a money move, for spend-cap accounting. The caps
// are USD-denominated whole units, but the raw token amount is not: a CELO or
// cEUR leg is worth more than $1 (cap could be bypassed) and a cKES/cNGN leg is
// worth far less (a normal remittance gets wrongly cap-blocked). This values USD
// stablecoins 1:1 and quotes everything else to cUSD via Mento, falling back to
// the nominal amount (never throwing) so a closed FX market cannot break a move.
import { formatUnits, parseUnits } from "viem";
import { getMento, resolveMentoToken } from "./mento.js";
import { isUsdStable } from "./usdStable.js";
import { log } from "./log.js";

export { isUsdStable };

export async function usdValueOf(tokenSymbol: string, amount: string): Promise<number> {
  const nominal = Number(amount);
  if (!Number.isFinite(nominal) || nominal <= 0) return 0;
  if (isUsdStable(tokenSymbol)) return nominal;
  try {
    const mento = await getMento();
    const inTok = await resolveMentoToken(tokenSymbol, mento);
    const cusd = await resolveMentoToken("cUSD", mento);
    if (inTok.address.toLowerCase() === cusd.address.toLowerCase()) return nominal;
    const quote = await mento.quotes.getAmountOut(
      inTok.address,
      cusd.address,
      parseUnits(amount, inTok.decimals),
    );
    return Number(formatUnits(quote, cusd.decimals));
  } catch (err) {
    log.warn({ err, tokenSymbol }, "usdValueOf quote failed; using nominal amount for the cap check");
    return nominal;
  }
}
