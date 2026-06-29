/**
 * Backtest engine — runs historical simulations on configurable strategies.
 *
 * Supported strategies:
 *   gap_fade  — Overnight gap fade (Kranthi's idea)
 *               Gap up ≥ N% at open → short, exit at +P% profit or stop or time window close
 *               Gap down ≥ N% at open → long,  exit at +P% profit or stop or time window close
 *
 * Uses Yahoo Finance daily OHLCV. Intraday simulation approximated via:
 *   - Win check:  gap-up SHORT → did Low reach target?  gap-down LONG → did High reach target?
 *   - Stop check: gap-up SHORT → did High hit stop?     gap-down LONG → did Low hit stop?
 *   - Tie (both on same day):  count as stop hit (conservative — real fill order unknown)
 *   - Time-out: if neither by EOD, exit at Close (conservative proxy for time-window close)
 *
 * POST body: { strategy, symbols, params }
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

// ── Yahoo Finance OHLCV fetch ──────────────────────────────────────────────────
interface DayBar { date: string; open: number; high: number; low: number; close: number; volume: number }

async function fetchDailyOHLCV(symbol: string, daysBack: number): Promise<DayBar[]> {
  try {
    const now    = Math.floor(Date.now() / 1000)
    const from   = now - daysBack * 86_400
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${from}&period2=${now}`
    const res    = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    const data   = await res.json()
    const result = data?.chart?.result?.[0]
    if (!result) return []
    const timestamps: number[] = result.timestamp ?? []
    const q = result.indicators?.quote?.[0] ?? {}
    const opens: number[]  = q.open  ?? []
    const highs: number[]  = q.high  ?? []
    const lows: number[]   = q.low   ?? []
    const closes: number[] = q.close ?? []
    const vols: number[]   = q.volume ?? []
    return timestamps.map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().split('T')[0],
      open:   opens[i],
      high:   highs[i],
      low:    lows[i],
      close:  closes[i],
      volume: vols[i],
    })).filter((d) => d.open && d.high && d.low && d.close)
  } catch {
    return []
  }
}

// ── Gap Fade Simulator ─────────────────────────────────────────────────────────

export interface GapFadeParams {
  gap_pct:       number   // min overnight gap to trade, e.g. 10 = 10%
  profit_pct:    number   // take-profit target, e.g. 10 = 10%
  stop_pct:      number   // stop loss, e.g. 5 = 5%
  min_price:     number   // skip penny stocks (e.g. $5)
  min_volume:    number   // skip illiquid (e.g. 500000)
  direction:     'both' | 'gap_up' | 'gap_down'
}

export interface BacktestTrade {
  date:       string
  symbol:     string
  direction:  'SHORT' | 'LONG'
  gap_pct:    number
  entry:      number
  exit:       number
  pnl_pct:    number
  result:     'WIN' | 'LOSS' | 'TIMEOUT'
}

export interface BacktestStats {
  trades:        number
  wins:          number
  losses:        number
  timeouts:      number
  win_rate:      number
  avg_win_pct:   number
  avg_loss_pct:  number
  profit_factor: number
  total_pnl_pct: number
  max_drawdown:  number
  best_trade:    number
  worst_trade:   number
  avg_gap_pct:   number
}

function runGapFade(bars: DayBar[], symbol: string, p: GapFadeParams): BacktestTrade[] {
  const trades: BacktestTrade[] = []

  for (let i = 1; i < bars.length; i++) {
    const prev  = bars[i - 1]
    const today = bars[i]
    if (!prev.close || !today.open || today.open < p.min_price) continue
    if (today.volume < p.min_volume) continue

    const gapPct = ((today.open - prev.close) / prev.close) * 100

    // Gap up — fade it (SHORT)
    if ((p.direction === 'both' || p.direction === 'gap_up') && gapPct >= p.gap_pct) {
      const entry    = today.open
      const target   = entry * (1 - p.profit_pct / 100)   // price goes DOWN for SHORT profit
      const stopPrice = entry * (1 + p.stop_pct / 100)    // price goes UP for SHORT stop

      const hitTarget = today.low  <= target
      const hitStop   = today.high >= stopPrice

      let exitPrice: number
      let result: BacktestTrade['result']

      if (hitStop && hitTarget) {
        // Both happened: conservatively assume stop hit (order unknown)
        exitPrice = stopPrice
        result = 'LOSS'
      } else if (hitTarget) {
        exitPrice = target
        result = 'WIN'
      } else if (hitStop) {
        exitPrice = stopPrice
        result = 'LOSS'
      } else {
        exitPrice = today.close
        result = 'TIMEOUT'
      }

      const pnl_pct = ((entry - exitPrice) / entry) * 100   // SHORT: profit when price falls

      trades.push({ date: today.date, symbol, direction: 'SHORT', gap_pct: gapPct, entry, exit: exitPrice, pnl_pct, result })
    }

    // Gap down — fade it (LONG)
    if ((p.direction === 'both' || p.direction === 'gap_down') && gapPct <= -p.gap_pct) {
      const entry     = today.open
      const target    = entry * (1 + p.profit_pct / 100)
      const stopPrice = entry * (1 - p.stop_pct / 100)

      const hitTarget = today.high >= target
      const hitStop   = today.low  <= stopPrice

      let exitPrice: number
      let result: BacktestTrade['result']

      if (hitStop && hitTarget) {
        exitPrice = stopPrice
        result = 'LOSS'
      } else if (hitTarget) {
        exitPrice = target
        result = 'WIN'
      } else if (hitStop) {
        exitPrice = stopPrice
        result = 'LOSS'
      } else {
        exitPrice = today.close
        result = 'TIMEOUT'
      }

      const pnl_pct = ((exitPrice - entry) / entry) * 100

      trades.push({ date: today.date, symbol, direction: 'LONG', gap_pct: Math.abs(gapPct), entry, exit: exitPrice, pnl_pct, result })
    }
  }

  return trades
}

function computeStats(trades: BacktestTrade[]): BacktestStats {
  if (trades.length === 0) {
    return { trades: 0, wins: 0, losses: 0, timeouts: 0, win_rate: 0, avg_win_pct: 0, avg_loss_pct: 0, profit_factor: 0, total_pnl_pct: 0, max_drawdown: 0, best_trade: 0, worst_trade: 0, avg_gap_pct: 0 }
  }
  const wins     = trades.filter((t) => t.result === 'WIN')
  const losses   = trades.filter((t) => t.result !== 'WIN')
  const timeouts = trades.filter((t) => t.result === 'TIMEOUT')

  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl_pct, 0) / wins.length     : 0
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl_pct, 0) / losses.length) : 0

  const totalProfit = wins.reduce((s, t) => s + t.pnl_pct, 0)
  const totalLoss   = Math.abs(losses.reduce((s, t) => s + (t.pnl_pct < 0 ? t.pnl_pct : 0), 0))

  // Drawdown on equal-weighted cumulative P&L
  let peak = 0, cumPnl = 0, maxDD = 0
  for (const t of trades.sort((a, b) => a.date.localeCompare(b.date))) {
    cumPnl += t.pnl_pct
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDD) maxDD = dd
  }

  return {
    trades:        trades.length,
    wins:          wins.length,
    losses:        losses.length,
    timeouts:      timeouts.length,
    win_rate:      Math.round((wins.length / trades.length) * 100),
    avg_win_pct:   Math.round(avgWin * 100) / 100,
    avg_loss_pct:  Math.round(avgLoss * 100) / 100,
    profit_factor: totalLoss > 0 ? Math.round((totalProfit / totalLoss) * 100) / 100 : totalProfit > 0 ? 99 : 0,
    total_pnl_pct: Math.round(trades.reduce((s, t) => s + t.pnl_pct, 0) * 100) / 100,
    max_drawdown:  Math.round(maxDD * 100) / 100,
    best_trade:    Math.round(Math.max(...trades.map((t) => t.pnl_pct)) * 100) / 100,
    worst_trade:   Math.round(Math.min(...trades.map((t) => t.pnl_pct)) * 100) / 100,
    avg_gap_pct:   Math.round(trades.reduce((s, t) => s + t.gap_pct, 0) / trades.length * 100) / 100,
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

const DEFAULT_SYMBOLS = [
  'NVDA', 'AMD', 'TSLA', 'MSTR', 'COIN', 'SMCI', 'META', 'AAPL', 'AMZN', 'MSFT',
  'GOOGL', 'ARM', 'PLTR', 'CRWD', 'SOFI', 'RIVN', 'MRVL', 'MU', 'INTC', 'NFLX',
  'SHOP', 'SQ', 'UPST', 'APP', 'ABNB', 'UBER', 'SNAP', 'SPOT', 'ZM', 'HOOD',
]

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      strategy?: string
      symbols?: string[]
      days_back?: number
      params?: Partial<GapFadeParams>
    }

    const strategy  = body.strategy  ?? 'gap_fade'
    const symbols   = (body.symbols && body.symbols.length > 0) ? body.symbols : DEFAULT_SYMBOLS
    const daysBack  = Math.min(body.days_back ?? 180, 365)

    if (strategy !== 'gap_fade') {
      return NextResponse.json({ error: 'Only gap_fade strategy supported currently' }, { status: 400 })
    }

    const params: GapFadeParams = {
      gap_pct:    body.params?.gap_pct    ?? 8,
      profit_pct: body.params?.profit_pct ?? 10,
      stop_pct:   body.params?.stop_pct   ?? 5,
      min_price:  body.params?.min_price  ?? 5,
      min_volume: body.params?.min_volume ?? 500_000,
      direction:  body.params?.direction  ?? 'both',
    }

    // Fetch all symbols in parallel (Yahoo Finance, max 10 concurrent)
    const CHUNK = 10
    const allTrades: BacktestTrade[] = []
    const skipped: string[] = []
    const symbolStats: Record<string, BacktestStats> = {}

    for (let i = 0; i < symbols.length; i += CHUNK) {
      const chunk = symbols.slice(i, i + CHUNK)
      const results = await Promise.all(chunk.map(async (sym) => {
        const bars = await fetchDailyOHLCV(sym, daysBack)
        if (bars.length < 5) { skipped.push(sym); return [] }
        return runGapFade(bars, sym, params)
      }))
      results.forEach((trades, idx) => {
        if (trades.length > 0) symbolStats[chunk[idx]] = computeStats(trades)
        allTrades.push(...trades)
      })
    }

    const stats = computeStats(allTrades)

    // Equity curve: daily cumulative equal-weighted P&L
    const byDate: Record<string, number> = {}
    for (const t of allTrades) {
      byDate[t.date] = (byDate[t.date] ?? 0) + t.pnl_pct
    }
    let cum = 0
    const equityCurve = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pnl]) => { cum += pnl; return { date, pnl: Math.round(cum * 100) / 100 } })

    // Top symbols by total P&L
    const topSymbols = Object.entries(symbolStats)
      .map(([sym, s]) => ({ symbol: sym, ...s }))
      .sort((a, b) => b.total_pnl_pct - a.total_pnl_pct)

    return NextResponse.json({
      strategy,
      params,
      symbols_tested: symbols.length - skipped.length,
      skipped,
      days_back: daysBack,
      stats,
      equity_curve: equityCurve,
      top_symbols: topSymbols.slice(0, 10),
      worst_symbols: topSymbols.slice(-5).reverse(),
      recent_trades: allTrades
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 50),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    strategies: ['gap_fade'],
    default_params: {
      gap_pct: 8, profit_pct: 10, stop_pct: 5,
      min_price: 5, min_volume: 500000, direction: 'both',
    },
    default_symbols: DEFAULT_SYMBOLS,
  })
}
