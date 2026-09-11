-- Full archive of Pavan's SF Essential Trades activity.
-- Every message is kept verbatim in `text` so the classification can be redone
-- later (by AI or better regex) without re-pulling Telegram history.
-- Populated by /api/telegram/pavan-archive; the poller appends new ones live.
create table if not exists public.tb_pavan_signals (
  id            bigserial primary key,
  msg_id        bigint      not null unique,   -- Telegram message id in the source channel
  topic_id      integer,
  topic_name    text,
  posted_at     timestamptz not null,
  sender        text,
  text          text        not null,

  kind          text,        -- entry | exit | hold | commentary
  trade_id      text,        -- Pavan's own "Trade ID:10122" when present
  symbol        text,
  entry_price   numeric,
  stop_loss     numeric,
  target_price  numeric,
  purchase_type text,        -- "Investment" | "Trade" — his stated hold horizon
  risk_pct      numeric,

  created_at    timestamptz not null default now()
);
create index if not exists tb_pavan_signals_posted_idx on public.tb_pavan_signals (posted_at desc);
create index if not exists tb_pavan_signals_symbol_idx on public.tb_pavan_signals (symbol);
create index if not exists tb_pavan_signals_kind_idx   on public.tb_pavan_signals (kind);
create index if not exists tb_pavan_signals_trade_idx  on public.tb_pavan_signals (trade_id);
