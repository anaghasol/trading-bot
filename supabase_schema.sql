-- ============================================================
-- TRADEBOT SCHEMA - Completely separate from sitara tables
-- Run this in: https://fskgekjysnstegbnqdzl.supabase.co/project/default/sql
-- ============================================================

create schema if not exists tradebot;

-- Account balance
create table if not exists tradebot.account (
  id         bigserial primary key,
  balance    numeric not null default 2000,
  daily_pnl  numeric default 0,
  total_pnl  numeric default 0,
  updated_at timestamptz default now()
);

-- All trades
create table if not exists tradebot.trades (
  id          bigserial primary key,
  symbol      text not null,
  action      text not null,
  quantity    numeric not null,
  entry_price numeric,
  exit_price  numeric,
  pnl         numeric default 0,
  pnl_pct     numeric default 0,
  status      text default 'OPEN',
  strategy    text default 'MICRO',
  reason      text,
  days_held   int default 0,
  created_at  timestamptz default now(),
  closed_at   timestamptz
);

-- Brain context/memory (smart: 1 row per key, auto-cleanup old)
create table if not exists tradebot.context (
  id         bigserial primary key,
  key        text unique not null,
  value      text not null,
  updated_at timestamptz default now()
);

-- Trade learnings (smart: keep only last 50, auto-delete older)
create table if not exists tradebot.learnings (
  id           bigserial primary key,
  symbol       text,
  strategy     text,
  pnl_pct      numeric,
  hold_days    int,
  regime       text,
  vix          numeric,
  volume_ratio numeric,
  rsi          numeric,
  outcome      text,
  lesson       text,
  created_at   timestamptz default now()
);

-- Auto-cleanup: keep only last 50 learnings to prevent DB bloat
create or replace function tradebot.cleanup_learnings()
returns trigger language plpgsql as $$
begin
  delete from tradebot.learnings
  where id not in (
    select id from tradebot.learnings
    order by created_at desc limit 50
  );
  return new;
end;
$$;

create or replace trigger tradebot_learnings_cleanup
after insert on tradebot.learnings
execute function tradebot.cleanup_learnings();

-- Daily summary (1 row per day, upsert)
create table if not exists tradebot.daily_summary (
  id               bigserial primary key,
  date             date unique not null,
  starting_balance numeric,
  ending_balance   numeric,
  daily_pnl        numeric default 0,
  total_pnl        numeric default 0,
  wins             int default 0,
  losses           int default 0,
  win_rate         numeric default 0,
  best_trade       text,
  worst_trade      text,
  regime           text,
  updated_at       timestamptz default now()
);

-- Strategy stats (1 row per strategy, running totals)
create table if not exists tradebot.strategy_stats (
  id            bigserial primary key,
  strategy      text unique not null,
  total_trades  int default 0,
  wins          int default 0,
  losses        int default 0,
  total_pnl     numeric default 0,
  avg_pnl_pct   numeric default 0,
  best_pnl_pct  numeric default 0,
  worst_pnl_pct numeric default 0,
  avg_hold_days numeric default 0,
  updated_at    timestamptz default now()
);

-- Seed initial data
insert into tradebot.account (balance, daily_pnl, total_pnl) values (2004.40, 0, 0);

insert into tradebot.context (key, value) values
  ('goal',      'Grow $2,000 to $25,000. Micro stocks under $60. Compound all profits.'),
  ('strategy',  'Micro momentum swing 1-3 days. Stop -5%. Trailing stop from peak. 5 positions max.'),
  ('risk',      'Max 30% per position. Keep $200 cash reserve. Stop if daily loss exceeds -3%. No PDT under $25K.'),
  ('pdt',       'Under $25K - max 3 day trades per 5 days. Must hold overnight. Target $25K for unlimited.'),
  ('watchlist', 'SPCE BBAI SMCI HIMS SOUN MARA RIOT SOFI RIVN OPEN LCID COIN ACHR IONQ RKLB'),
  ('balance',   '2004.40'),
  ('total_pnl', '0.00'),
  ('last_date', 'system initialized'),
  ('adaptive',  'NORMAL - no trade history yet');

insert into tradebot.strategy_stats (strategy) values ('MICRO'), ('SWING'), ('MICRO_SWING');

-- Expose tradebot schema to PostgREST (required for API access)
grant usage on schema tradebot to anon, authenticated, service_role;
grant all on all tables in schema tradebot to anon, authenticated, service_role;
grant all on all sequences in schema tradebot to anon, authenticated, service_role;
