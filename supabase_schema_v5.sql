-- ============================================================
-- TRADEBOT SCHEMA v5 — Dual-broker hardening
-- Run at: https://fskgekjysnstegbnqdzl.supabase.co/project/default/sql
-- ============================================================

-- Backfill NULLs to 'schwab' (legacy rows pre-dual-broker)
update public.tb_trades  set broker = 'schwab' where broker is null;
update public.tb_alerts  set broker = 'schwab' where broker is null;

-- NOT NULL constraints (broker column must always be set)
alter table public.tb_trades  alter column broker set not null;
alter table public.tb_alerts  alter column broker set not null;

-- Compound indexes for broker-filtered date queries (dashboard, reporting)
create index if not exists idx_tb_trades_broker_date
  on public.tb_trades(broker, created_at desc);

create index if not exists idx_tb_pnl_snapshots_broker_date
  on public.tb_pnl_snapshots(broker, date desc);

-- Combined performance view for dual-broker reporting
create or replace view public.vw_combined_performance as
select
  broker,
  count(*)                                              as total_trades,
  sum(case when pnl > 0 then 1 else 0 end)             as wins,
  sum(case when pnl <= 0 then 1 else 0 end)            as losses,
  round(sum(case when pnl > 0 then 1 else 0 end)::numeric
        / nullif(count(*), 0) * 100, 1)                as win_rate_pct,
  round(sum(pnl)::numeric, 2)                          as total_pnl,
  round(avg(pnl)::numeric, 2)                          as avg_pnl_per_trade
from public.tb_trades
where status = 'CLOSED'
group by broker;

grant select on public.vw_combined_performance to anon, authenticated, service_role;
