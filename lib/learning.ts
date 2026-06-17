/**
 * Daily learning engine.
 * Builds context from recent trade outcomes and feeds it to Claude
 * so the AI improves its picks based on what's actually working.
 */
import { createServiceClient } from './supabase-server'
import { buildIntentionContext } from './tg-intentions'

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

  const [{ data: recentTrades }, { data: recentNarratives }] = await Promise.all([
    db.from('tb_trades')
      .select('symbol, strategy, pnl, pnl_pct, regime, confidence, reason, created_at, closed_at')
      .eq('status', 'CLOSED')
      .gte('closed_at', sevenDaysAgo)
      .order('closed_at', { ascending: false })
      .limit(50),
    // Pull the last 20 trade narratives from tb_learnings — these are the "show don't tell" examples
    db.from('tb_learnings')
      .select('lesson, outcome, created_at')
      .gte('created_at', sevenDaysAgo)
      .not('lesson', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

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

  // Pavan's active intentions — the most actionable part of the context
  let intentionContext = ''
  try { intentionContext = await buildIntentionContext() } catch { /* non-fatal */ }

  // Recent trade memories: the AI learns from actual closed trades, not just stats.
  // Format: "WIN NVDA +11.4% TREND 2d | EMA20_BOUNCE conf=82 TG=yes | EXIT:PARTIAL-2 $158.80"
  // Wins and losses interleaved so the AI sees both patterns.
  const narrativeLines = (recentNarratives ?? [])
    .filter((r) => r.lesson && (r.lesson.startsWith('WIN') || r.lesson.startsWith('LOSS')))
    .map((r) => r.lesson as string)
  const narrativeBlock = narrativeLines.length
    ? `TRADE MEMORY (last ${narrativeLines.length} closed — learn from outcomes):\n${narrativeLines.join('\n')}`
    : ''

  const summary = [
    macroStanceLine,       // macro stance first (may block all new trades)
    intentionContext,      // specific per-stock intentions from Pavan
    `7-day: ${wins.length}W/${losses.length}L (${win_rate_7d.toFixed(0)}% win rate) | Avg win: +${avgWin.toFixed(1)}%, Avg loss: ${avgLoss.toFixed(1)}%.`,
    best_setups.length  ? `Best setups: ${best_setups.join(', ')}.` : '',
    avoid_setups.length ? `AVOID: ${avoid_setups.join(', ')} (losing).` : '',
    Object.keys(regime_performance).length
      ? `Regime P&L: ${Object.entries(regime_performance).map(([r, v]) => `${r}=${v > 0 ? '+' : ''}${v}%`).join(', ')}.`
      : '',
    advisorLine,
    narrativeBlock,        // concrete trade examples last — most actionable signal
  ].filter(Boolean).join('\n')

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

// ── Trade Narrative ───────────────────────────────────────────────────────────
// Composes a single dense line per closed trade. Used as:
//   1. AI prompt context — "here's what actually worked and why"
//   2. Future pgvector embeddings — semantic search over trade history
//
// Format:
//   WIN NVDA +11.4% TREND 2d | EMA20_BOUNCE conf=82 TG=yes RS=88 regime=GOOD | EXIT: PARTIAL-2 $158.80

export interface TradeRecord {
  symbol: string
  strategy: string
  pnl_pct: number
  hold_days: number
  regime: string
  exit_type: string          // STOP_LOSS | TRAILING_STOP | PARTIAL-1 | PARTIAL-2 | TIME_STOP | FLAT_RECYCLE
  exit_price: number
  entry_price: number
  hold_mode?: string         // day | swing | trend
  confidence?: number
  reason?: string            // full reason string — parsed for TG flag, RS, EMA score, category
  broker?: string
}

export function composeTradeNarrative(t: TradeRecord): string {
  const outcome  = t.pnl_pct >= 0 ? 'WIN' : 'LOSS'
  const pnlStr   = `${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(1)}%`
  const mode     = (t.hold_mode ?? 'swing').toUpperCase()

  // Parse structured fields embedded in the reason string
  const r = t.reason ?? ''
  const tgConfirmed  = r.includes('📡TG') || r.includes('TG-zone') || r.includes('TG-watch')
  const emaScore     = r.match(/ema=(\d+)\/10/)?.[1] ?? null
  const claudeConf   = r.match(/claude=(\d+)%/)?.[1] ?? (t.confidence ? String(t.confidence) : null)
  const category     = r.match(/cat=(\w+)/)?.[1] ?? null
  const reentry      = r.includes('reentry')

  // Build entry context: what triggered this trade
  const entryParts = [
    t.strategy,
    claudeConf  ? `conf=${claudeConf}`       : null,
    emaScore    ? `RS=${emaScore}`            : null,
    tgConfirmed ? 'TG=yes'                   : 'TG=no',
    `regime=${t.regime}`,
    category    ? `sector=${category}`        : null,
    reentry     ? 're-entry'                  : null,
    t.broker    ? `[${t.broker}]`            : null,
  ].filter(Boolean).join(' ')

  // Exit context: why we left
  const exitStr = `EXIT:${t.exit_type} $${t.exit_price.toFixed(2)}`

  return `${outcome} ${t.symbol} ${pnlStr} ${mode} ${t.hold_days}d | ${entryParts} | ${exitStr}`
}

// Save a completed trade to learnings for future context
export async function recordLearning(trade: TradeRecord) {
  const db = createServiceClient()
  const narrative = composeTradeNarrative(trade)

  await db.from('tb_learnings').insert({
    symbol:       trade.symbol,
    strategy:     trade.strategy,
    pnl_pct:      trade.pnl_pct,
    hold_days:    trade.hold_days,
    regime:       trade.regime,
    outcome:      trade.pnl_pct >= 0 ? 'WIN' : 'LOSS',
    lesson:       narrative,
    created_at:   new Date().toISOString(),
  })

  // Also write narrative to tb_trades.trade_summary if the column exists.
  // Run in background — never blocks the main close flow.
  // SQL to add column: ALTER TABLE tb_trades ADD COLUMN IF NOT EXISTS trade_summary text;
}
