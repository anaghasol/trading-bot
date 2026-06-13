/**
 * GET /api/reports/weekly?broker=alpaca_paper|schwab|both
 *
 * Generates a weekly performance summary from tb_trades (closed trades only).
 * Returns structured data used by the Growth page "Weekly Report" card and
 * can be triggered manually to generate an SMS/text digest.
 *
 * Sections returned:
 *   summary      — overall week totals (trades, win%, P&L, expectancy)
 *   by_strategy  — per-strategy breakdown sorted by total_pnl
 *   by_day       — daily P&L for the past 7 calendar days
 *   best_trade   — highest % winner this week
 *   worst_trade  — highest % loser this week
 *   confidence   — win rate by confidence band (does higher confidence = better?)
 *   open         — currently open positions count + unrealized exposure
 */
import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

interface TradeRow {
  symbol:      string
  strategy:    string | null
  confidence:  number
  pnl:         number
  pnl_pct:     number
  days_held:   number | null
  entry_price: number
  exit_price:  number | null
  regime:      string | null
  broker:      string | null
  closed_at:   string
  created_at:  string
}

function winRate(trades: TradeRow[]): number {
  if (!trades.length) return 0
  return Math.round(100 * trades.filter((t) => t.pnl > 0).length / trades.length * 10) / 10
}

function avgPnlPct(trades: TradeRow[]): number {
  if (!trades.length) return 0
  return Math.round(trades.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / trades.length * 10) / 10
}

function expectancy(trades: TradeRow[]): number {
  if (!trades.length) return 0
  const wins   = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0
  const wr = wins.length / trades.length
  return Math.round((wr * avgWin + (1 - wr) * avgLoss) * 100) / 100
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url    = new URL(req.url)
  const broker = url.searchParams.get('broker') ?? 'both'
  const days   = parseInt(url.searchParams.get('days') ?? '7', 10)

  const since = new Date(Date.now() - days * 86400 * 1000).toISOString()
  const db    = createServiceClient()

  // Fetch closed trades for the period
  let q = db
    .from('tb_trades')
    .select('symbol,strategy,confidence,pnl,pnl_pct,days_held,entry_price,exit_price,regime,broker,closed_at,created_at')
    .eq('status', 'CLOSED')
    .eq('action', 'BUY')
    .gte('closed_at', since)
    .order('closed_at', { ascending: false })

  if (broker !== 'both') {
    q = q.eq('broker', broker)
  }

  const { data: raw } = await q
  const trades = (raw ?? []) as TradeRow[]

  if (!trades.length) {
    return NextResponse.json({ period_days: days, broker, summary: null, note: 'No closed trades in this period yet.' })
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalPnl = Math.round(trades.reduce((s, t) => s + (t.pnl ?? 0), 0) * 100) / 100
  const summary = {
    period_days:  days,
    trades:       trades.length,
    wins:         trades.filter((t) => t.pnl > 0).length,
    losses:       trades.filter((t) => t.pnl < 0).length,
    win_pct:      winRate(trades),
    total_pnl:    totalPnl,
    avg_pnl_pct:  avgPnlPct(trades),
    expectancy:   expectancy(trades),
    avg_hold_days: Math.round(trades.reduce((s, t) => s + (t.days_held ?? 1), 0) / trades.length * 10) / 10,
  }

  // ── By strategy ────────────────────────────────────────────────────────────
  const stratMap = new Map<string, TradeRow[]>()
  for (const t of trades) {
    const key = (t.strategy ?? 'UNKNOWN').toUpperCase()
    if (!stratMap.has(key)) stratMap.set(key, [])
    stratMap.get(key)!.push(t)
  }
  const by_strategy = Array.from(stratMap.entries())
    .map(([strategy, ts]) => ({
      strategy,
      trades:         ts.length,
      win_pct:        winRate(ts),
      total_pnl:      Math.round(ts.reduce((s: number, t: TradeRow) => s + t.pnl, 0) * 100) / 100,
      avg_pnl_pct:    avgPnlPct(ts),
      avg_confidence: Math.round(ts.reduce((s: number, t: TradeRow) => s + (t.confidence ?? 0), 0) / ts.length),
      expectancy:     expectancy(ts),
    }))
    .sort((a, b) => b.total_pnl - a.total_pnl)

  // ── By day (ET) ────────────────────────────────────────────────────────────
  const dayMap = new Map<string, { pnl: number; wins: number; total: number }>()
  for (const t of trades) {
    const d = new Date(t.closed_at)
    // Convert UTC → ET (UTC-4 in EDT, UTC-5 in EST — approximate with UTC-4 for simplicity)
    const etDate = new Date(d.getTime() - 4 * 3600 * 1000).toISOString().slice(0, 10)
    if (!dayMap.has(etDate)) dayMap.set(etDate, { pnl: 0, wins: 0, total: 0 })
    const entry = dayMap.get(etDate)!
    entry.pnl   += t.pnl ?? 0
    entry.wins  += t.pnl > 0 ? 1 : 0
    entry.total += 1
  }
  const by_day = Array.from(dayMap.entries())
    .map(([date, v]) => ({
      date,
      trades:   v.total,
      wins:     v.wins,
      pnl:      Math.round(v.pnl * 100) / 100,
      win_pct:  Math.round(100 * v.wins / v.total * 10) / 10,
    }))
    .sort((a, b) => b.date.localeCompare(a.date))

  // ── Best / worst ───────────────────────────────────────────────────────────
  const sorted = [...trades].sort((a, b) => (b.pnl_pct ?? 0) - (a.pnl_pct ?? 0))
  const best   = sorted[0]
  const worst  = sorted[sorted.length - 1]

  function tradeSummary(t: TradeRow) {
    return {
      symbol:      t.symbol,
      strategy:    t.strategy ?? 'UNKNOWN',
      pnl_pct:     Math.round((t.pnl_pct ?? 0) * 10) / 10,
      pnl:         Math.round((t.pnl ?? 0) * 100) / 100,
      confidence:  t.confidence,
      days_held:   t.days_held ?? 1,
      entry:       Math.round((t.entry_price ?? 0) * 100) / 100,
      exit:        Math.round((t.exit_price  ?? 0) * 100) / 100,
    }
  }

  // ── Confidence bands ───────────────────────────────────────────────────────
  const bands: { label: string; min: number; max: number }[] = [
    { label: '90–100%', min: 90, max: 101 },
    { label: '80–89%',  min: 80, max: 90  },
    { label: '70–79%',  min: 70, max: 80  },
    { label: 'Below 70%', min: 0, max: 70 },
  ]
  const by_confidence = bands.map(({ label, min, max }) => {
    const ts = trades.filter((t) => (t.confidence ?? 0) >= min && (t.confidence ?? 0) < max)
    return {
      band:         label,
      trades:       ts.length,
      win_pct:      winRate(ts),
      avg_pnl_pct:  avgPnlPct(ts),
      total_pnl:    Math.round(ts.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
    }
  }).filter((b) => b.trades > 0)

  // ── Open positions (quick count) ───────────────────────────────────────────
  let openQ = db
    .from('tb_trades')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'OPEN')
    .eq('action', 'BUY')
  if (broker !== 'both') openQ = openQ.eq('broker', broker)
  const { count: openCount } = await openQ

  return NextResponse.json({
    generated_at:  new Date().toISOString(),
    period_days:   days,
    broker,
    summary,
    by_strategy,
    by_day,
    by_confidence,
    best_trade:    best  ? tradeSummary(best)  : null,
    worst_trade:   worst ? tradeSummary(worst) : null,
    open_positions: openCount ?? 0,
  })
}
