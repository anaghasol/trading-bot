/**
 * CRON: /api/cron/scan — the continuous-trading entry loop.
 * Runs BOTH Schwab (real, protected) and Alpaca (paper, aggressive lab) concurrently.
 *
 * UPGRADE (this build): the scanner is now profile + sleeve + rotation aware.
 *   1. profileFor(broker)   → per-broker risk personality (protected vs lab)
 *   2. getCategoryMomentum()→ rank themes; skip COLD, boost HOT (daily rotation)
 *   3. getSleeveAllocation()→ each entry is sized against its time-horizon sleeve
 *
 * Each AI pick is routed:  setup → sleeve → (budget × risk × category-bias) → qty.
 * All Supabase contracts (tb_trades / tb_alerts / tb_cron_log, broker-column
 * fallback) are unchanged — this is additive sizing/selection logic only.
 */
import { NextResponse } from 'next/server'
import * as SchwabBroker from '@/lib/schwab'
import * as AlpacaBroker from '@/lib/alpaca'
import { getRecommendations } from '@/lib/ai-advisor'
import { analyzePdtStatus } from '@/lib/pdt'
import { isMarketOpen, isDailyLossExceeded } from '@/lib/risk'
import { createServiceClient } from '@/lib/supabase-server'
import { profileFor } from '@/lib/strategy-profiles'
import { getCategoryMomentum, biasForSymbol, categoryLabel, type RotationResult } from '@/lib/category-rotation'
import { getSleeveAllocation, sleeveForSetup, sleeveSizing } from '@/lib/sleeves'

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
  rotation: RotationResult,
): Promise<{ trades_made: number; message: string }> {

  const isSchwab = broker === 'schwab'
  const api      = isSchwab ? SchwabBroker : AlpacaBroker
  const profile  = profileFor(broker)

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

  // Daily-loss breaker: enforced on real money (Schwab); paper lab runs looser.
  if (isSchwab && isDailyLossExceeded(dailyPnl, equity)) {
    return { trades_made: 0, message: `[${broker}] Daily loss limit hit (−5%)` }
  }

  if (positions.length >= profile.max_positions) {
    return { trades_made: 0, message: `[${broker}] Full: ${positions.length}/${profile.max_positions}` }
  }

  const heldSymbols = positions.map((p) => p.symbol)
  const alloc       = await getSleeveAllocation(db)

  // Pass broker so EMA scanner uses correct watchlist (core vs wide)
  // and Claude gets the right confidence gate (78% live, 68% paper)
  const { recommendations, regime, scanned, candidates } =
    await getRecommendations(equity, heldSymbols, pdt.day_trades_remaining, broker)

  // Rotation overlay: drop picks in COLD themes (bias 0), then rank by
  // confidence × category bias so hot themes win the open slots.
  const ranked = recommendations
    .filter((r) => !heldSymbols.includes(r.symbol))
    .map((r) => ({ rec: r, bias: biasForSymbol(r.symbol, rotation) }))
    .filter((x) => x.bias > 0)
    .sort((a, b) => (b.rec.confidence * b.bias) - (a.rec.confidence * a.bias))

  let tradesMade = 0
  const openSlots = profile.max_positions - positions.length

  for (const { rec, bias } of ranked.slice(0, openSlots)) {
    const quote = isSchwab
      ? await SchwabBroker.getQuote(rec.symbol)
      : await AlpacaBroker.getQuote(rec.symbol)
    if (!quote || quote.price <= 0) continue

    // Route the pick to its sleeve and size against that horizon's budget.
    const sleeve = sleeveForSetup(rec.setup)
    const sizing = sleeveSizing(sleeve, profile, equity, quote.price, alloc, bias)
    if (sizing.qty < 1) continue

    const { buy, stop_order_id } = isSchwab
      ? await SchwabBroker.placeBuyWithProtection(rec.symbol, sizing.qty, sizing.trail_pct)
      : await AlpacaBroker.placeBuyWithProtection(rec.symbol, sizing.qty, sizing.trail_pct)

    if (buy.status === 'PLACED') {
      tradesMade++

      const initialStop = quote.price * (1 - sizing.stop_pct)
      const target      = quote.price * (1 + sizing.stop_pct * 2)
      const cat         = categoryLabel(rec.symbol)
      const riskNote = ` | sleeve=${sleeve} cat=${cat} stop=$${initialStop.toFixed(2)} target=$${target.toFixed(2)} stop_id=${stop_order_id ?? 'n/a'}`

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

      const alertRow = {
        type: 'BUY',
        message: `[${broker.toUpperCase()}] BUY ${sizing.qty} ${rec.symbol} @ $${quote.price.toFixed(2)} · ${sleeve}/${cat} · ${rec.reason} (${rec.confidence}%)`,
        symbol: rec.symbol,
      }
      const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
      if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)
    }
  }

  const hot = rotation.hottest ? ` Hot:${rotation.hottest}` : ''
  return {
    trades_made: tradesMade,
    message: `[${broker}] Regime:${regime.regime}${hot} PDT:${pdt.day_trades_used}/3 Scanned:${scanned} Candidates:${candidates} Ranked:${ranked.length} Trades:${tradesMade}`,
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db = createServiceClient()
  const engines = await getEngineStatus(db)

  // Rank themes once per tick and share across both brokers.
  const rotation = await getCategoryMomentum()

  const results: Record<string, unknown> = {}
  const tasks: Promise<void>[] = []

  if (engines.schwab === 'running') {
    tasks.push(
      runScan('schwab', db, rotation).then((r) => {
        results.schwab = r
        return db.from('tb_cron_log').insert({ job: 'scan', status: 'success', trades_made: r.trades_made, message: r.message }).then(() => {})
      }).catch((e) => { results.schwab = { error: e.message } })
    )
  } else {
    results.schwab = { skipped: 'engine_stopped' }
  }

  if (engines.alpaca_paper === 'running') {
    tasks.push(
      runScan('alpaca_paper', db, rotation).then((r) => {
        results.alpaca_paper = r
        return db.from('tb_cron_log').insert({ job: 'scan', status: 'success', trades_made: r.trades_made, message: r.message }).then(() => {})
      }).catch((e) => { results.alpaca_paper = { error: e.message } })
    )
  } else {
    results.alpaca_paper = { skipped: 'engine_stopped' }
  }

  await Promise.allSettled(tasks)

  return NextResponse.json({
    status: 'ok',
    engines,
    rotation: rotation.categories.map((c) => ({ key: c.key, rank: c.rank, temp: c.temp, score: c.score, bias: c.bias })),
    results,
  })
}
