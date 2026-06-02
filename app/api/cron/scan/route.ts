/**
 * CRON: /api/cron/scan — runs BOTH Schwab and Alpaca concurrently.
 * Each broker checked independently; both can be stopped via /api/engine.
 */
import { NextResponse } from 'next/server'
import * as SchwabBroker from '@/lib/schwab'
import * as AlpacaBroker from '@/lib/alpaca'
import { getRecommendations } from '@/lib/ai-advisor'
import { analyzePdtStatus, SWING_CONFIG } from '@/lib/pdt'
import { calculatePositionSize, isMarketOpen, isDailyLossExceeded } from '@/lib/risk'
import { ALL_SYMBOLS, ALL_ALPACA_SYMBOLS } from '@/lib/market-data'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

async function getEngineStatus(db: ReturnType<typeof createServiceClient>) {
  const { data } = await db.from('tb_context').select('key, value').in('key', ['engine_schwab', 'engine_alpaca'])
  return {
    schwab:       data?.find((r) => r.key === 'engine_schwab')?.value ?? 'running',
    alpaca_paper: data?.find((r) => r.key === 'engine_alpaca')?.value ?? 'running',
  }
}

// ── Shared scan logic ─────────────────────────────────────────────────────────

async function runScan(
  broker: 'schwab' | 'alpaca_paper',
  db: ReturnType<typeof createServiceClient>,
  scanSymbolOverride?: string[]
): Promise<{ trades_made: number; message: string }> {

  const isSchwab = broker === 'schwab'
  const api = isSchwab ? SchwabBroker : AlpacaBroker

  const [positions, balance, orders] = await Promise.all([
    api.getPositions(),
    api.getAccountBalance(),
    api.getOrders(7),
  ])

  const equity = balance ?? (isSchwab ? 2000 : 100000)
  const pdt    = analyzePdtStatus(orders, equity)

  const { data: acctRow } = await db
    .from('tb_account').select('daily_pnl').order('id', { ascending: false }).limit(1).single()
  const dailyPnl = acctRow?.daily_pnl ?? 0

  if (!isSchwab) {
    // Alpaca paper: no PDT restriction, bigger risk tolerance
  } else if (isDailyLossExceeded(dailyPnl, equity)) {
    return { trades_made: 0, message: `[${broker}] Daily loss limit hit` }
  }

  if (positions.length >= SWING_CONFIG.max_positions) {
    return { trades_made: 0, message: `[${broker}] Full: ${positions.length}/${SWING_CONFIG.max_positions}` }
  }

  const heldSymbols = positions.map((p) => p.symbol)

  // Alpaca paper gets larger watchlist for more opportunities
  const { recommendations, regime, position_size_pct, scanned, candidates } =
    await getRecommendations(equity, heldSymbols, pdt.day_trades_remaining)

  let tradesMade = 0
  const openSlots = SWING_CONFIG.max_positions - positions.length

  for (const rec of recommendations.slice(0, openSlots)) {
    if (heldSymbols.includes(rec.symbol)) continue

    const quote = isSchwab
      ? await SchwabBroker.getQuote(rec.symbol)
      : await AlpacaBroker.getQuote(rec.symbol)

    if (!quote || quote.price <= 0) continue

    // Risk-based sizing: Alpaca paper uses more aggressive 2% risk since it's fake money
    const riskPct = isSchwab ? 0.012 : 0.020
    const sizing  = calculatePositionSize(equity, quote.price, 0.025)
    // Override qty for Alpaca (more aggressive)
    if (!isSchwab) {
      const aggressiveDollars = equity * riskPct / (quote.price * 0.025)
      sizing.qty = Math.max(1, Math.floor(aggressiveDollars))
    }

    if (sizing.qty === 0) continue

    const { buy, stop_order_id } = isSchwab
      ? await SchwabBroker.placeBuyWithProtection(rec.symbol, sizing.qty, 5.0)
      : await AlpacaBroker.placeBuyWithProtection(rec.symbol, sizing.qty, 5.0)

    if (buy.status === 'PLACED') {
      tradesMade++

      const riskNote = ` | stop=$${sizing.initial_stop.toFixed(2)} target=$${sizing.target_price.toFixed(2)} stop_id=${stop_order_id ?? 'n/a'}`
      const tradeRow: Record<string, unknown> = {
        symbol: rec.symbol, action: 'BUY', quantity: sizing.qty,
        entry_price: quote.price, status: 'OPEN',
        strategy: rec.setup, reason: rec.reason + riskNote,
        confidence: rec.confidence, regime: regime.regime,
        created_at: new Date().toISOString(),
      }

      // Try with broker column (schema v4), fall back without
      const { error } = await db.from('tb_trades').insert({ ...tradeRow, broker })
      if (error?.code === 'PGRST204') await db.from('tb_trades').insert(tradeRow)

      // Insert alert with broker tag
      const alertRow = {
        type: 'BUY',
        message: `[${broker.toUpperCase()}] BUY ${sizing.qty} ${rec.symbol} @ $${quote.price.toFixed(2)} | ${rec.reason} (${rec.confidence}%)`,
        symbol: rec.symbol,
      }
      const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
      if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)
    }
  }

  return {
    trades_made: tradesMade,
    message: `[${broker}] Regime:${regime.regime} PDT:${pdt.day_trades_used}/3 Scanned:${scanned} Candidates:${candidates} Trades:${tradesMade}`,
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db = createServiceClient()
  const engines = await getEngineStatus(db)

  const results: Record<string, unknown> = {}

  // Run both concurrently
  const tasks: Promise<void>[] = []

  if (engines.schwab === 'running') {
    tasks.push(
      runScan('schwab', db).then((r) => {
        results.schwab = r
        return db.from('tb_cron_log').insert({ job: 'scan', status: 'success', trades_made: r.trades_made, message: r.message }).then(() => {})
      }).catch((e) => { results.schwab = { error: e.message } })
    )
  } else {
    results.schwab = { skipped: 'engine_stopped' }
  }

  if (engines.alpaca_paper === 'running') {
    tasks.push(
      runScan('alpaca_paper', db).then((r) => {
        results.alpaca_paper = r
        return db.from('tb_cron_log').insert({ job: 'scan', status: 'success', trades_made: r.trades_made, message: r.message }).then(() => {})
      }).catch((e) => { results.alpaca_paper = { error: e.message } })
    )
  } else {
    results.alpaca_paper = { skipped: 'engine_stopped' }
  }

  await Promise.allSettled(tasks)

  return NextResponse.json({ status: 'ok', engines, results })
}
