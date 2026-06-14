-- RemitRoute initial schema. Source of truth for the five core tables.
-- Apply with: pnpm db:migrate

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  minipay_address text,
  telegram_id text unique,
  display_name text,
  city text,
  country text,
  wallet_address text not null,
  wallet_key_ref text not null,
  self_verified boolean default false,
  created_at timestamptz default now()
);

create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  kind text not null,
  params jsonb not null,
  cadence text not null,
  next_run timestamptz not null,
  status text default 'active',
  created_at timestamptz default now()
);

create table if not exists executions (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid references schedules(id),
  user_id uuid references users(id),
  kind text not null,
  tx_hash text,
  status text not null,
  amount_in numeric,
  token_in text,
  amount_out numeric,
  token_out text,
  fee_currency text,
  error text,
  created_at timestamptz default now()
);

create table if not exists treasury_actions (
  id uuid primary key default gen_random_uuid(),
  strategy text not null,
  tx_hash text,
  status text not null,
  detail jsonb,
  created_at timestamptz default now()
);

create table if not exists feedback_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  agent_id text,
  client_address text,
  score int,
  tag text,
  tx_hash text,
  x402_proof text,
  created_at timestamptz default now()
);

-- Helpful indexes for the heartbeat and the dashboard.
create index if not exists idx_schedules_due on schedules (next_run) where status = 'active';
create index if not exists idx_executions_user_created on executions (user_id, created_at desc);
create index if not exists idx_executions_created on executions (created_at desc);
