// Drizzle schema mirroring the RemitRoute Postgres schema exactly. This is the
// source of truth that scripts and the app read and write.
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  minipayAddress: text("minipay_address").unique(),
  telegramId: text("telegram_id").unique(),
  displayName: text("display_name"),
  city: text("city"),
  country: text("country"),
  walletAddress: text("wallet_address").notNull(),
  walletKeyRef: text("wallet_key_ref").notNull(),
  selfVerified: boolean("self_verified").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const schedules = pgTable("schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  kind: text("kind").notNull(),
  params: jsonb("params").notNull(),
  cadence: text("cadence").notNull(),
  nextRun: timestamp("next_run", { withTimezone: true }).notNull(),
  status: text("status").default("active"),
  // How many times the current due action has been retried after a transient
  // failure. Reset to 0 once it succeeds or is rescheduled to the next cadence.
  retryCount: integer("retry_count").default(0),
  // Consecutive run failures across cadence slots; a permanently failing
  // schedule auto-pauses once this crosses MAX_CONSECUTIVE_FAILURES.
  consecutiveFailures: integer("consecutive_failures").default(0),
  // When a heartbeat claimed this row (status -> processing). A reclaim sweep at
  // cycle start resets rows whose claim is older than the cycle timeout.
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const executions = pgTable("executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleId: uuid("schedule_id").references(() => schedules.id),
  userId: uuid("user_id").references(() => users.id),
  kind: text("kind").notNull(),
  txHash: text("tx_hash"),
  status: text("status").notNull(),
  amountIn: numeric("amount_in"),
  tokenIn: text("token_in"),
  amountOut: numeric("amount_out"),
  tokenOut: text("token_out"),
  feeCurrency: text("fee_currency"),
  error: text("error"),
  // The heartbeat cycle that produced this row.
  cycleId: uuid("cycle_id"),
  // Deterministic intent id (hash of schedule+user+kind+params+due-slot), the
  // real idempotency key: a unique (user_id, intent_id) index prevents a second
  // broadcast across retries and cycles. Independent of cycle_id.
  intentId: text("intent_id"),
  // USD-equivalent value of the move, used for spend-cap accounting so
  // local-currency legs are not mis-counted by their nominal token amount.
  usdValue: numeric("usd_value"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Single-use sign-in nonces (EIP-4361). Issued by /api/auth/nonce, consumed by
// /api/auth/verify. DB-backed because Vercel runs many serverless instances.
export const authNonces = pgTable("auth_nonces", {
  id: uuid("id").primaryKey().defaultRandom(),
  address: text("address").notNull(),
  nonce: text("nonce").notNull().unique(),
  used: boolean("used").default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// x402 EIP-3009 replay store: a payer's authorization nonce may settle once.
export const x402Nonces = pgTable("x402_nonces", {
  payer: text("payer").notNull(),
  nonce: text("nonce").notNull(),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Per-user confirmed remittance recipients. A schedule may only send to an
// address on this list, added through the authenticated confirm flow.
export const recipients = pgTable("recipients", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  address: text("address").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Named savings goals. A goal wraps a savings_sweep schedule: contributions
// accumulate toward target_usd, and while lock_until is in the future the
// engine refuses Aave withdrawals that would cut into the goal's locked value.
export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  scheduleId: uuid("schedule_id").references(() => schedules.id),
  name: text("name").notNull(),
  asset: text("asset").notNull().default("cUSD"),
  targetUsd: numeric("target_usd").notNull(),
  targetDate: timestamp("target_date", { withTimezone: true }),
  lockUntil: timestamp("lock_until", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Applied-migration ledger so migrate.ts runs each file at most once.
export const schemaMigrations = pgTable("schema_migrations", {
  filename: text("filename").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow(),
});

// DB-backed fixed-window rate limiting (per-IP / per-principal) for public and
// auth routes; works across serverless instances.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).defaultNow(),
});

export const treasuryActions = pgTable("treasury_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategy: text("strategy").notNull(),
  txHash: text("tx_hash"),
  status: text("status").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const feedbackLog = pgTable("feedback_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  agentId: text("agent_id"),
  clientAddress: text("client_address"),
  score: integer("score"),
  tag: text("tag"),
  txHash: text("tx_hash"),
  x402Proof: text("x402_proof"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Global circuit breaker: a single 'singleton' row the heartbeat reads before
// moving money. When status is 'halted' the engine skips every cycle until an
// operator clears it (Phase 11).
export const engineState = pgTable("engine_state", {
  id: text("id").primaryKey().default("singleton"),
  status: text("status").notNull().default("running"),
  haltReason: text("halt_reason"),
  haltedAt: timestamp("halted_at", { withTimezone: true }),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Per-cycle audit trail of the heartbeat for the dashboard and anomaly checks.
export const engineCycles = pgTable("engine_cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  cycleId: uuid("cycle_id"),
  gasPass: boolean("gas_pass"),
  halted: boolean("halted").default(false),
  loaded: integer("loaded"),
  attempted: integer("attempted"),
  succeeded: integer("succeeded"),
  failed: integer("failed"),
  skipped: integer("skipped"),
  volume: numeric("volume"),
  aborted: boolean("aborted"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Schedule = typeof schedules.$inferSelect;
export type Execution = typeof executions.$inferSelect;
export type NewExecution = typeof executions.$inferInsert;
