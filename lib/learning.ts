/**
 * Daily learning engine.
 * Builds context from recent trade outcomes and feeds it to Claude
 * so the AI improves its picks based on what's actually working.
 */
import { createServiceClient } from './supabase-server'

export interface LearningContext {
  summary: string
  win_rate_7d: number
  best_setups: string[]
  avoid_setups: string[]
  best_times: string[]
  regime_performance: Record<string, number>
  recent_losses: string[]
}

export async function buildLearningContext(): Promise<LearningContext> {
  const db = createServiceClient()

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: recentTrades } = await db
    .from('tb_trades')
    .select('symbol, strategy, pnl, pnl_pct, regime, confidence, reason, created_at, closed_at')
    .eq('status', 'CLOSED')
    .gte('closed_at', sevenDaysAgo)
    .order('closed_at', { ascending: false })
    .limit(50)

  if (!recentTrades || recentTrades.length === 0) {
    return {
      summary: 'No trade history yet. Use momentum breakout setups with high volume confirmation.',
      win_rate_7d: 0,
      best_setups: ['MOMENTUM_BREAKOUT'],
      avoid_setups: [],
      best_times: ['9:45-11:00 AM ET'],
      regime_performance: {},
      recent_losses: [],
    }
  }

  const wins   = recentTrades.filter((t) => t.pnl > 0)
  const losses = recentTrades.filter((t) => t.pnl <= 0)
  const win_rate_7d = (wins.length / recentTrades.length) * 100

  // Which setups are profitable?
  const setupPnl = new Map<string, number[]>()
  for (const t of recentTrades) {
    const s = t.strategy || 'UNKNOWN'
    if (!setupPnl.has(s)) setupPnl.set(s, [])
    setupPnl.get(s)!.push(t.pnl_pct)
  }

  const setupAvg = Array.from(setupPnl.entries() as Iterable<[string, number[]]>).map(([setup, pnls]) => ({
    setup,
    avg: pnls.reduce((a, b) => a + b, 0) / pnls.length,
    count: pnls.length,
  })).sort((a, b) => b.avg - a.avg)

  const best_setups  = setupAvg.filter((s) => s.avg > 0 && s.count >= 2).map((s) => s.setup)
  const avoid_setups = setupAvg.filter((s) => s.avg < -2 && s.count >= 2).map((s) => s.setup)

  // Regime performance
  const regimePnl = new Map<string, number[]>()
  for (const t of recentTrades) {
    const r = t.regime || 'NORMAL'
    if (!regimePnl.has(r)) regimePnl.set(r, [])
    regimePnl.get(r)!.push(t.pnl_pct)
  }
  const regime_performance: Record<string, number> = {}
  for (const [r, pnls] of Array.from(regimePnl.entries() as Iterable<[string, number[]]>)) {
    regime_performance[r] = Math.round((pnls.reduce((a: number, b: number) => a + b, 0) / pnls.length) * 10) / 10
  }

  const recent_losses = losses.slice(0, 5).map((t) =>
    `${t.symbol} ${t.pnl_pct.toFixed(1)}% (${t.strategy})`
  )

  const avgWin  = wins.length  ? wins.reduce((s, t)  => s + t.pnl_pct, 0) / wins.length  : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_pct, 0) / losses.length : 0

  // Current macro stance (set by TG poller when Pavan gives broad market call)
  const { data: macroRow } = await db.from('tb_settings').select('value').eq('key', 'tg_macro_stance').single()
  let macroStanceLine = ''
  if (macroRow?.value) {
    try {
      const macro = JSON.parse(macroRow.value) as { stance: string; set_at: string; insight: string }
      const hoursAgo = (Date.now() - new Date(macro.set_at).getTime()) / 3600000
      if (hoursAgo < 18) {
        macroStanceLine = macro.stance === 'bearish'
          ? `⚠️ ADVISOR MACRO: BEARISH (${hoursAgo.toFixed(0)}h ago) — ${macro.insight} DO NOT open new positions.`
          : `✅ ADVISOR MACRO: BULLISH (${hoursAgo.toFixed(0)}h ago) — ${macro.insight}`
      }
    } catch { /* ignore parse error */ }
  }

  // SF Trades advisor insights from last 3 days
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const { data: advisorInsights } = await db
    .from('tb_learning')
    .select('symbol, sentiment, sector, insight, created_at')
    .gte('created_at', threeDaysAgo)
    .not('symbol', 'is', null)   // ticker-specific only; macro already captured above
    .order('created_at', { ascending: false })
    .limit(30)

  // Summarise advisor sentiment per ticker
  const bullish: string[] = []
  const bearish: string[] = []
  const sectorNotes: string[] = []

  for (const ins of advisorInsights ?? []) {
    if (ins.sentiment === 'bullish' && ins.symbol && !bullish.includes(ins.symbol)) bullish.push(ins.symbol)
    if (ins.sentiment === 'bearish' && ins.symbol && !bearish.includes(ins.symbol)) bearish.push(ins.symbol)
    if (ins.sector && !sectorNotes.includes(ins.sector)) sectorNotes.push(ins.sector)
  }

  // Watch zones — stocks advisor flagged for future entry
  const watchZones: string[] = []
  for (const ins of advisorInsights ?? []) {
    if (ins.insight?.includes('Watch zone:') && ins.symbol) {
      const zone = ins.insight.match(/Watch zone: ([^\s]+)/)?.[1]
      if (zone) watchZones.push(`${ins.symbol} @ ${zone}`)
    }
  }

  const advisorLine = [
    bullish.length ? `SF Trades advisor bullish on: ${bullish.join(', ')}.` : '',
    bearish.length ? `SF Trades advisor bearish/stopped on: ${bearish.join(', ')} — avoid re-entry.` : '',
    sectorNotes.length ? `Hot sectors per advisor: ${sectorNotes.join(', ')}.` : '',
    watchZones.length ? `Advisor watching for entry: ${watchZones.join(', ')}.` : '',
  ].filter(Boolean).join(' ')

  const summary = [
    macroStanceLine,   // always first so Claude sees it immediately
    `7-day performance: ${wins.length}W/${losses.length}L (${win_rate_7d.toFixed(0)}% win rate).`,
    `Avg win: +${avgWin.toFixed(1)}%, Avg loss: ${avgLoss.toFixed(1)}%.`,
    best_setups.length  ? `Best setups: ${best_setups.join(', ')}.` : '',
    avoid_setups.length ? `Avoid setups: ${avoid_setups.join(', ')} (underperforming).` : '',
    recent_losses.length ? `Recent losses: ${recent_losses.join('; ')}.` : '',
    Object.keys(regime_performance).length
      ? `Regime P&L: ${Object.entries(regime_performance).map(([r, v]) => `${r}=${v > 0 ? '+' : ''}${v}%`).join(', ')}.`
      : '',
    advisorLine,
  ].filter(Boolean).join(' ')

  return {
    summary,
    win_rate_7d,
    best_setups: best_setups.length ? best_setups : ['MOMENTUM_BREAKOUT', 'REVERSAL'],
    avoid_setups,
    best_times: ['9:45-10:30 AM ET', '2:00-3:00 PM ET'],
    regime_performance,
    recent_losses,
  }
}

// Save a completed trade to learnings for future context
export async function recordLearning(trade: {
  symbol: string
  strategy: string
  pnl_pct: number
  hold_days: number
  regime: string
  entry_rsi?: number
  volume_ratio?: number
}) {
  const db = createServiceClient()
  const outcome = trade.pnl_pct >= 0 ? 'WIN' : 'LOSS'
  const lesson = trade.pnl_pct >= 5
    ? `Strong winner: ${trade.strategy} in ${trade.regime} regime with ${trade.hold_days} day hold`
    : trade.pnl_pct >= 0
    ? `Small win: ${trade.strategy} — target higher quality setups`
    : trade.pnl_pct >= -3
    ? `Small loss: ${trade.strategy} — setup didn't confirm`
    : `Large loss: ${trade.strategy} — stop loss hit, avoid similar in ${trade.regime} regime`

  await db.from('tb_learnings').insert({
    symbol:       trade.symbol,
    strategy:     trade.strategy,
    pnl_pct:      trade.pnl_pct,
    hold_days:    trade.hold_days,
    regime:       trade.regime,
    rsi:          trade.entry_rsi ?? null,
    volume_ratio: trade.volume_ratio ?? null,
    outcome,
    lesson,
    created_at: new Date().toISOString(),
  })
}
