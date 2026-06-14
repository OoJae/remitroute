// Centralized, validated configuration. Every script and route reads from here.
// All external config comes from env. No secrets live in the repo.
import "dotenv/config";
import { z } from "zod";

// Coerce a decimal string env var into a number, with a default.
const numeric = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().nonnegative());

const boolean = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return def;
      return v === "true" || v === "1" || v === "yes";
    });

const schema = z.object({
  CELO_RPC: z.string().url().default("https://forno.celo.org"),
  CELO_RPC_FALLBACK: z.string().url().default("https://rpc.ankr.com/celo"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Optional while DRY_RUN is true. Required before a real send.
  AGENT_PRIVATE_KEY: z.string().optional(),
  AGENT_WALLET_ADDRESS: z.string().optional(),

  DRY_RUN: boolean(true),

  // User-initiated withdraws (own funds back to the depositor's MiniPay address)
  // are real onchain even while the automated engine stays DRY_RUN. Set false to
  // make withdraws dry-run too. The destination is always the user's own address.
  WITHDRAW_LIVE: boolean(true),

  FEE_CURRENCY: z.enum(["cUSD", "USDC"]).default("cUSD"),
  GAS_FLOOR: numeric(0.5),

  PER_USER_DAILY_CAP: numeric(50),
  GLOBAL_DAILY_CAP: numeric(500),
  // Max value (USD-equivalent whole units) any single action may move.
  PER_TX_CAP: numeric(25),

  // Anomaly circuit breaker: halt the engine when one heartbeat cycle records
  // at least ANOMALY_MAX_FAILURES failed executions. Manual reset only.
  ANOMALY_HALT_ENABLED: boolean(true),
  ANOMALY_MAX_FAILURES: numeric(3),

  // How many times a transiently-failed due action is retried (on the next
  // heartbeat) before it is rescheduled to the next cadence.
  MAX_RETRIES: numeric(1),
  // Hard drift band (bps) for an early fx_rebalance between scheduled runs.
  HARD_DRIFT_BPS: numeric(1000),

  // Minimum balance (whole units) to leave liquid in the execution wallet when a
  // savings sweep supplies idle funds to yield, so gas and due transfers still work.
  SWEEP_MIN_LIQUID: numeric(1),

  // 32-byte hex (64 chars). Required to encrypt or decrypt execution-wallet keys.
  ENCRYPTION_KEY: z.string().optional(),

  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASEURL: z.string().optional(),

  // MiMo (Anthropic-compatible endpoint) for the natural-language rule parser.
  MIMO_API_KEY: z.string().optional(),
  MIMO_BASE_URL: z.string().default("https://token-plan-sgp.xiaomimimo.com/anthropic"),
  MIMO_MODEL: z.string().default("mimo-v2.5-pro"),

  // ERC-8004. Validate on Sepolia first, then flip to mainnet.
  ERC8004_NETWORK: z.enum(["mainnet", "sepolia"]).default("sepolia"),
  ERC8004_RPC: z.string().url().default("https://forno.celo.org"),
  ERC8004_RPC_SEPOLIA: z.string().url().default("https://forno.celo-sepolia.celo-testnet.org"),
  // Separate monitoring wallet posts metric tags (the registry blocks the owner
  // from rating its own agent). The owner wallet is AGENT_PRIVATE_KEY.
  MONITORING_PRIVATE_KEY: z.string().optional(),
  MONITORING_WALLET_ADDRESS: z.string().optional(),
  // Pinata JWT for pinning the registration JSON to IPFS.
  PINATA_JWT: z.string().optional(),
  // Agent token id, set after register.ts mints the identity.
  AGENT_ID: z.string().optional(),
  // Self Agent ID (human-backed soulbound id), set after registering at
  // app.ai.self.xyz. When present, the registration JSON advertises it.
  SELF_AGENT_ID: z.string().optional(),

  // x402 paid FX-route API (thirdweb facilitator on Celo).
  THIRDWEB_SECRET_KEY: z.string().optional(),
  THIRDWEB_CLIENT_ID: z.string().optional(),
  SERVER_WALLET_ADDRESS: z.string().optional(), // thirdweb server wallet that settles
  X402_PRICE: z.string().default("$0.01"),
  X402_PAYTO: z.string().optional(), // defaults to the agent owner wallet

  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;

// Guard used by money-moving scripts. Throws a clear message when a real send
// is attempted without a key. DRY_RUN never needs a key.
export function requireAgentKey(): `0x${string}` {
  if (config.DRY_RUN) {
    throw new Error("requireAgentKey called while DRY_RUN is true");
  }
  const key = config.AGENT_PRIVATE_KEY;
  if (!key || !key.startsWith("0x")) {
    throw new Error(
      "AGENT_PRIVATE_KEY is missing. Set a funded hot-wallet key and DRY_RUN=false to send real transactions.",
    );
  }
  return key as `0x${string}`;
}
