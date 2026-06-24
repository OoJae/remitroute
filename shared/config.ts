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
  // are real onchain even while the automated engine stays DRY_RUN. The
  // destination is always the user's own address, so this is never a theft
  // primitive, but it moves real money, so it defaults OFF: an operator must set
  // WITHDRAW_LIVE=true explicitly in prod to enable real user withdrawals.
  WITHDRAW_LIVE: boolean(false),

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
  // Consecutive run failures (across cadence slots) before a schedule auto-pauses,
  // so a permanently failing rule stops burning gas and stops tripping the breaker.
  MAX_CONSECUTIVE_FAILURES: numeric(5),
  // Half-open auto-recovery: a tripped breaker auto-resumes after this many
  // minutes so a one-off failure burst does not wedge the engine forever.
  ANOMALY_HALT_COOLDOWN_MIN: numeric(30),
  // A schedule stuck in "processing" longer than this (a crash mid-cycle) is
  // reclaimed back to active at the next cycle start.
  RECLAIM_STALE_MIN: numeric(10),
  // Hard drift band (bps) for an early fx_rebalance between scheduled runs.
  HARD_DRIFT_BPS: numeric(1000),

  // Minimum balance (whole units) to leave liquid in the execution wallet when a
  // savings sweep supplies idle funds to yield, so gas and due transfers still work.
  SWEEP_MIN_LIQUID: numeric(1),

  // 32-byte hex (64 chars). Required to encrypt or decrypt execution-wallet keys.
  ENCRYPTION_KEY: z.string().optional(),
  // Previous key during a rotation: decrypt falls back to it so old ciphertext
  // still reads until rotate-encryption-key.ts has re-encrypted every row.
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),

  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASEURL: z.string().optional(),

  // MiMo (Anthropic-compatible endpoint) for the natural-language rule parser.
  MIMO_API_KEY: z.string().optional(),
  MIMO_BASE_URL: z.string().default("https://token-plan-sgp.xiaomimimo.com/anthropic"),
  MIMO_MODEL: z.string().default("mimo-v2.5-pro"),

  // ERC-8004. Defaults to mainnet (where the money engine runs); set sepolia
  // explicitly only for testnet validation. A startup assertion below cross-checks
  // this against the money chain so the reputation stack cannot silently diverge.
  ERC8004_NETWORK: z.enum(["mainnet", "sepolia"]).default("mainnet"),
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

  // x402 paid FX-route API (self-hosted EIP-3009 facilitator on Celo).
  THIRDWEB_SECRET_KEY: z.string().optional(),
  THIRDWEB_CLIENT_ID: z.string().optional(),
  // Master switch for the paid API. When false the route returns 404 and never
  // settles, so it cannot be abused while unused.
  X402_ENABLED: boolean(true),
  X402_PRICE: z
    .string()
    .default("$0.01")
    .refine((v) => /^\$?\d+(\.\d+)?$/.test(v.trim()), "X402_PRICE must look like $0.01"),
  X402_PAYTO: z.string().optional(), // defaults to the agent owner wallet
  // Dedicated, minimally-funded relayer that submits x402 settlements. Kept
  // separate from AGENT_PRIVATE_KEY so an attacker forcing settlements cannot
  // drain the engine's gas wallet. Falls back to AGENT_PRIVATE_KEY if unset.
  RELAYER_PRIVATE_KEY: z.string().optional(),
  RELAYER_WALLET_ADDRESS: z.string().optional(),

  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  // --- Security + ops (added in the hardening pass) ---
  // HMAC secret for signed session cookies. MUST be distinct from ENCRYPTION_KEY
  // (never reuse the wallet-encryption key for sessions). 32+ random bytes hex.
  SESSION_SECRET: z.string().optional(),
  // Current ENCRYPTION_KEY version, written into new ciphertext (v<N>.iv.tag.cipher)
  // so keys can be rotated with lazy re-encryption.
  ENCRYPTION_KEY_VERSION: numeric(1),
  // Operator alert sink (Slack/Telegram/generic webhook). notify() posts JSON here.
  ALERT_WEBHOOK_URL: z.string().optional(),
  // Dead-man's-switch ping (e.g. healthchecks.io) hit once per healthy heartbeat.
  DEADMAN_PING_URL: z.string().optional(),
  // DB-backed rate limiting for public/auth routes.
  RATE_LIMIT_WINDOW_SEC: numeric(60),
  RATE_LIMIT_MAX: numeric(30),
  // Node env; production turns on stricter required-secret assertions below.
  NODE_ENV: z.string().default("development"),
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

// Soft startup checks (warn, never crash the build). Hard, fail-closed checks
// live in the helpers that consume each secret (crypto.ts for ENCRYPTION_KEY,
// auth.ts for SESSION_SECRET), so a missing secret fails its specific feature at
// runtime rather than the whole process at import time.
if (config.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
  if (!config.ENCRYPTION_KEY)
    console.warn("[config] ENCRYPTION_KEY not set in production; wallet features will fail");
  if (!config.SESSION_SECRET)
    console.warn("[config] SESSION_SECRET not set in production; authentication will fail");
  if (!config.DRY_RUN && config.ERC8004_NETWORK !== "mainnet")
    console.warn(
      "[config] money engine is live but ERC8004_NETWORK is not mainnet; reputation writes target the wrong network",
    );
}

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
