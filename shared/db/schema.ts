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
  // The heartbeat cycle that produced this row. A unique (schedule_id, cycle_id)
  // index makes a double-execution impossible at the database (Phase 11).
  cycleId: uuid("cycle_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
