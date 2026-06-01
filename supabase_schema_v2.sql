-- ============================================================
-- TRADEBOT SCHEMA v2
-- Tables use public schema with tb_ prefix (matches existing tables)
-- Run at: https://fskgekjysnstegbnqdzl.supabase.co/project/default/sql
-- ============================================================

-- Add missing columns to existing tb_trades table
alter table public.tb_trades
  add column if not exists confidence  numeric default 0,
  add column if not exists regime      text default 'NORMAL',
  add column if not exists peak_pnl    numeric default 0;

-- Schwab OAuth tokens (single row, auto-refreshed by app)
create table if not exists public.tb_schwab_tokens (
  id            bigint primary key default 1,
  access_token  text not null,
  refresh_token text not null,
  account_hash  text not null default '',
  expiry        timestamptz not null,
  updated_at    timestamptz default now(),
  constraint tb_schwab_tokens_single_row check (id = 1)
);

-- Seed current Schwab tokens (will be auto-refreshed on first use)
insert into public.tb_schwab_tokens (id, access_token, refresh_token, account_hash, expiry)
values (
  1,
  'I0.b2F1dGgyLmNkYy5zY2h3YWIuY29t.bm1YsdIUpDZ0o0JYrowQuYn8F2lHlE9iHeZqNalQZPw@',
  'KCRUWRMQlW-hrhQmnw46QcYGmARrnGbmwXukf4vfheOHjTI2RPeatzYgVtgUxPOABeh7rrrDN8PC2sXd3x6cCUu6yEx-cZwy0kr3g4caolQ1C7JIV4NyZZe87MTe4dnPzZtaK-ByqiI@',
  '246BA5574609AB8409DA15BA3B99B7091F958CF9D6E189655E2D2F1C0BAD9A89',
  '2026-06-01T14:35:17+00:00'
) on conflict (id) do update set
  access_token  = excluded.access_token,
  refresh_token = excluded.refresh_token,
  account_hash  = excluded.account_hash,
  expiry        = excluded.expiry,
  updated_at    = now();

-- Alerts / notifications
create table if not exists public.tb_alerts (
  id         bigserial primary key,
  type       text not null default 'INFO',
  message    text not null,
  symbol     text,
  pnl        numeric,
  is_read    boolean default false,
  created_at timestamptz default now()
);

-- Cron execution log
create table if not exists public.tb_cron_log (
  id          bigserial primary key,
  job         text not null,
  status      text not null,
  trades_made int default 0,
  message     text,
  duration_ms int,
  created_at  timestamptz default now()
);

-- Intraday P&L snapshots (hourly, for chart)
create table if not exists public.tb_pnl_snapshots (
  id         bigserial primary key,
  date       date not null default current_date,
  hour       int not null,
  balance    numeric not null,
  daily_pnl  numeric default 0,
  created_at timestamptz default now(),
  unique (date, hour)
);

-- Grant access to all tb_ tables
grant all on public.tb_schwab_tokens  to anon, authenticated, service_role;
grant all on public.tb_alerts         to anon, authenticated, service_role;
grant all on public.tb_cron_log       to anon, authenticated, service_role;
grant all on public.tb_pnl_snapshots  to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;
