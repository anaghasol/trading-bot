-- ============================================================
-- MyTrade — Performance by Strategy Analysis
-- Run this in Supabase SQL Editor (Database → SQL Editor)
-- All figures are for CLOSED trades only.
-- ============================================================

-- ── 1. Performance by Strategy ──────────────────────────────
SELECT
  COALESCE(NULLIF(strategy, ''), 'UNKNOWN')        AS strategy,
  broker,
  COUNT(*)                                          AS trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)         AS wins,
  SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END)         AS losses,
  ROUND(
    100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1
  )                                                 AS win_pct,
  ROUND(SUM(pnl)::numeric, 2)                       AS total_pnl,
  ROUND(AVG(pnl)::numeric, 2)                       AS avg_pnl,
  ROUND(AVG(pnl_pct)::numeric, 1)                   AS avg_pnl_pct,
  ROUND(AVG(days_held)::numeric, 1)                 AS avg_hold_days,
  ROUND(AVG(confidence)::numeric, 0)                AS avg_confidence,
  -- Expectancy = (win_rate × avg_win) + (loss_rate × avg_loss)
  ROUND(
    (
      1.0 * SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / NULLIF(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0)
      * (1.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0))
    ) + (
      1.0 * SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END) / NULLIF(SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END), 0)
      * (1.0 * SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0))
    ),
    2
  )                                                 AS expectancy_per_trade
FROM tb_trades
WHERE status = 'CLOSED'
  AND action = 'BUY'
GROUP BY strategy, broker
ORDER BY broker, total_pnl DESC;


-- ── 2. Performance by Confidence Tier ───────────────────────
SELECT
  broker,
  CASE
    WHEN confidence >= 90 THEN '90–100%'
    WHEN confidence >= 80 THEN '80–89%'
    WHEN confidence >= 70 THEN '70–79%'
    ELSE                       'Below 70%'
  END                                               AS confidence_band,
  COUNT(*)                                          AS trades,
  ROUND(
    100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1
  )                                                 AS win_pct,
  ROUND(AVG(pnl_pct)::numeric, 1)                   AS avg_pnl_pct,
  ROUND(SUM(pnl)::numeric, 2)                       AS total_pnl
FROM tb_trades
WHERE status = 'CLOSED' AND action = 'BUY'
GROUP BY broker, confidence_band
ORDER BY broker, confidence_band DESC;


-- ── 3. Performance by Market Regime ─────────────────────────
SELECT
  broker,
  COALESCE(NULLIF(regime, ''), 'UNKNOWN')           AS regime,
  COUNT(*)                                          AS trades,
  ROUND(
    100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1
  )                                                 AS win_pct,
  ROUND(AVG(pnl_pct)::numeric, 1)                   AS avg_pnl_pct,
  ROUND(SUM(pnl)::numeric, 2)                       AS total_pnl
FROM tb_trades
WHERE status = 'CLOSED' AND action = 'BUY'
GROUP BY broker, regime
ORDER BY broker, total_pnl DESC;


-- ── 4. Weekly Performance Summary (last 7 days) ─────────────
SELECT
  broker,
  DATE_TRUNC('day', closed_at AT TIME ZONE 'America/New_York') AS trade_date,
  COUNT(*)                                                      AS trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                     AS wins,
  ROUND(SUM(pnl)::numeric, 2)                                   AS day_pnl,
  ROUND(AVG(pnl_pct)::numeric, 1)                               AS avg_pnl_pct
FROM tb_trades
WHERE status = 'CLOSED'
  AND action = 'BUY'
  AND closed_at >= NOW() - INTERVAL '7 days'
GROUP BY broker, trade_date
ORDER BY trade_date DESC, broker;


-- ── 5. Best Individual Trades (top 10 by P&L %) ─────────────
SELECT
  closed_at::date                                   AS date,
  broker,
  symbol,
  COALESCE(NULLIF(strategy, ''), 'UNKNOWN')         AS strategy,
  confidence,
  days_held,
  ROUND(entry_price::numeric, 2)                    AS entry,
  ROUND(exit_price::numeric, 2)                     AS exit,
  ROUND(pnl_pct::numeric, 1)                        AS pnl_pct,
  ROUND(pnl::numeric, 2)                            AS pnl_usd
FROM tb_trades
WHERE status = 'CLOSED' AND action = 'BUY' AND pnl > 0
ORDER BY pnl_pct DESC
LIMIT 10;


-- ── 6. Worst Individual Trades (bottom 10 by P&L %) ─────────
SELECT
  closed_at::date                                   AS date,
  broker,
  symbol,
  COALESCE(NULLIF(strategy, ''), 'UNKNOWN')         AS strategy,
  confidence,
  days_held,
  ROUND(entry_price::numeric, 2)                    AS entry,
  ROUND(exit_price::numeric, 2)                     AS exit,
  ROUND(pnl_pct::numeric, 1)                        AS pnl_pct,
  ROUND(pnl::numeric, 2)                            AS pnl_usd
FROM tb_trades
WHERE status = 'CLOSED' AND action = 'BUY' AND pnl < 0
ORDER BY pnl_pct ASC
LIMIT 10;
