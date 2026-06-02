-- ============================================================
-- TRADEBOT SCHEMA v4 — Dual broker support
-- Run at: https://fskgekjysnstegbnqdzl.supabase.co/project/default/sql
-- ============================================================

-- Tag all trades + alerts with which broker placed them
alter table public.tb_trades add column if not exists broker text default 'schwab';
alter table public.tb_alerts add column if not exists broker text default 'schwab';
alter table public.tb_pnl_snapshots add column if not exists broker text default 'schwab';

-- Engine status per broker (start/stop control)
create table if not exists public.tb_engine_status (
  broker      text primary key,
  status      text not null default 'running',  -- 'running' | 'stopped'
  stopped_by  text,                              -- 'user' | 'daily_loss'
  updated_at  timestamptz default now()
);

insert into public.tb_engine_status (broker, status) values
  ('schwab',       'running'),
  ('alpaca_paper', 'running')
on conflict (broker) do update set updated_at = now();

-- Indexes for broker-filtered queries
create index if not exists idx_tb_trades_broker  on public.tb_trades(broker);
create index if not exists idx_tb_alerts_broker  on public.tb_alerts(broker);

grant all on public.tb_engine_status to anon, authenticated, service_role;
