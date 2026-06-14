// x402 health check: GET the fx-route endpoint with no payment and confirm it
// returns a proper 402 payment-required response (live + priced). No money moves.
//
// Run: tsx openclaw/skills/x402-service/scripts/health.ts
import { config } from "../../../../shared/config.js";
import { log } from "../../../../shared/log.js";

async function main(): Promise<void> {
  const url = `${config.APP_BASE_URL.replace(/\/$/, "")}/api/fx-route?tokenIn=cUSD&tokenOut=cKES&amountIn=1`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  const ok = res.status === 402;
  log.info(
    { url, status: res.status, accepts: (body as { accepts?: unknown }).accepts, ok },
    ok ? "x402 health ok: endpoint live and priced (402)" : "x402 health: unexpected status",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  log.error({ err }, "x402 health failed");
  process.exit(1);
});
