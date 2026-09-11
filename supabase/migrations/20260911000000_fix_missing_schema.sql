-- Repairs every column/table the code references that does not exist in the DB.
-- Found by auditing all .from('tb_*') call sites against the live schema.
-- Each of these failed silently at runtime: PostgREST rejected the statement,
-- the error was swallowed or only console.error'd, and execution continued.

-- ── tb_trades: TG signal journaling ─────────────────────────────────────────
-- Missing columns made EVERY strategy='TG_SIGNAL' insert fail, so the table has
-- zero TG_SIGNAL rows in its entire history. health-cron then re-journaled the
-- orphaned broker positions as RECOVERED, dropping the tg_trade=1 flag that
-- protects signal trades from internal exit rules.
alter table public.tb_trades add column if not exists stop_loss    numeric;
alter table public.tb_trades add column if not exists target_price numeric;
alter table public.tb_trades add column if not exists order_id     text;

-- ── tb_learning: channel advisor picks ──────────────────────────────────────
-- Distinct from tb_learnings (trade-outcome lessons). This table never existed,
-- so lib/ai-advisor.ts and cron/options have never seen a single Telegram pick.
create table if not exists public.tb_learning (
  id          bigserial primary key,
  symbol      text,
  source      text,
  sentiment   text,
  sector      text,
  insight     text,
  created_at  timestamptz not null default now()
);
create index if not exists tb_learning_created_idx on public.tb_learning (created_at desc);
create index if not exists tb_learning_symbol_idx  on public.tb_learning (symbol);

-- ── tb_discoveries ──────────────────────────────────────────────────────────
alter table public.tb_discoveries add column if not exists rs_spy numeric;

-- ── tb_eod_reports ──────────────────────────────────────────────────────────
alter table public.tb_eod_reports add column if not exists date           date;
alter table public.tb_eod_reports add column if not exists broker         text;
alter table public.tb_eod_reports add column if not exists total_trades   integer;
alter table public.tb_eod_reports add column if not exists wins           integer;
alter table public.tb_eod_reports add column if not exists losses         integer;
alter table public.tb_eod_reports add column if not exists win_rate       numeric;
alter table public.tb_eod_reports add column if not exists profit_factor  numeric;
alter table public.tb_eod_reports add column if not exists total_pnl      numeric;
alter table public.tb_eod_reports add column if not exists avg_win        numeric;
alter table public.tb_eod_reports add column if not exists avg_loss       numeric;
alter table public.tb_eod_reports add column if not exists entries        integer;
alter table public.tb_eod_reports add column if not exists stops_fired    integer;
alter table public.tb_eod_reports add column if not exists partials_taken integer;
alter table public.tb_eod_reports add column if not exists issues         text;
alter table public.tb_eod_reports add column if not exists config_changes text;
alter table public.tb_eod_reports add column if not exists new_config     text;
alter table public.tb_eod_reports add column if not exists created_at     timestamptz not null default now();
-- upsert uses onConflict: 'date,broker'
create unique index if not exists tb_eod_reports_date_broker_idx
  on public.tb_eod_reports (date, broker);

-- ── tb_research_reports ─────────────────────────────────────────────────────
create table if not exists public.tb_research_reports (
  id             bigserial primary key,
  prompt_key     text,
  prompt_name    text,
  firm           text,
  output         text,
  market_context text,
  created_at     timestamptz not null default now()
);
create index if not exists tb_research_reports_created_idx
  on public.tb_research_reports (created_at desc);
