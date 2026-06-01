-- ============================================================
-- TRADEBOT SCHEMA v3 — Elite risk engine columns
-- Run at: https://fskgekjysnstegbnqdzl.supabase.co/project/default/sql
-- ============================================================

-- Add risk tracking columns to tb_trades
alter table public.tb_trades
  add column if not exists initial_stop_price   numeric,         -- entry * 0.975 (2.5% stop)
  add column if not exists peak_price            numeric,         -- highest price seen
  add column if not exists trailing_stop_price   numeric,         -- peak * 0.95
  add column if not exists target_price          numeric,         -- entry * 1.05 (2:1 target)
  add column if not exists partial_exit_done     boolean  default false,
  add column if not exists partial_exit_qty      int      default 0,
  add column if not exists days_held             int      default 0,
  add column if not exists exit_type             text;            -- INITIAL_STOP, TRAILING_STOP, TIME_STOP, TARGET

-- Backfill initial_stop_price for any existing OPEN trades
update public.tb_trades
  set initial_stop_price = entry_price * 0.975,
      peak_price         = entry_price,
      trailing_stop_price = entry_price * 0.95,
      target_price       = entry_price * 1.05
where status = 'OPEN'
  and entry_price is not null
  and initial_stop_price is null;

-- Performance indexes
create index if not exists idx_tb_trades_status    on public.tb_trades(status);
create index if not exists idx_tb_trades_symbol    on public.tb_trades(symbol);
create index if not exists idx_tb_trades_created   on public.tb_trades(created_at desc);
create index if not exists idx_tb_alerts_created   on public.tb_alerts(created_at desc);
create index if not exists idx_tb_cron_log_created on public.tb_cron_log(created_at desc);

-- Daily P&L view (useful for compounding calc)
create or replace view public.tb_daily_stats as
  select
    date_trunc('day', closed_at at time zone 'America/New_York') as trade_date,
    count(*) as trades,
    sum(case when pnl > 0 then 1 else 0 end) as wins,
    sum(case when pnl <= 0 then 1 else 0 end) as losses,
    round(sum(pnl)::numeric, 2) as total_pnl,
    round(avg(pnl_pct)::numeric, 2) as avg_pnl_pct,
    round(max(pnl_pct)::numeric, 2) as best_pnl_pct,
    round(min(pnl_pct)::numeric, 2) as worst_pnl_pct
  from public.tb_trades
  where status = 'CLOSED' and closed_at is not null
  group by 1
  order by 1 desc;

grant select on public.tb_daily_stats to anon, authenticated, service_role;
