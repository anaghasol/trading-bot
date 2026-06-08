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
import { alertTradeEntered, alertPreMarket } from '@/lib/notify'
import { createServiceClient } from '@/lib/supabase-server'
import { profileFor } from '@/lib/strategy-profiles'
import { getCategoryMomentum, biasForSymbol, categoryLabel, type RotationResult } from '@/lib/category-rotation'
import { getSleeveAllocation, sleeveForSetup, sleeveSizing } from '@/lib/sleeves'
import { getActiveIntentions, markActed } from '@/lib/tg-intentions'

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

  // Macro bearish gate: if Pavan said "hold off on new purchases" within last 18h, pause entries
  try {
    const { data: macroRow } = await db.from('tb_settings').select('value').eq('key', 'tg_macro_stance').single()
    if (macroRow?.value) {
      const macro = JSON.parse(macroRow.value) as { stance: string; set_at: string }
      const hoursAgo = (Date.now() - new Date(macro.set_at).getTime()) / 3600000
      if (macro.stance === 'bearish' && hoursAgo < 18) {
        return { trades_made: 0, message: `[${broker}] Macro bearish pause — advisor said hold off ${hoursAgo.toFixed(0)}h ago` }
      }
    }
  } catch { /* non-fatal — if this fails, scan continues */ }

  // (position cap enforced after regime check using dynamicMaxPos below)

  // Total exposure cap: don't open new positions if already > 75% equity deployed
  // Prevents margin usage on volatile names like MARA/SOUN that size up fast
  const MAX_EXPOSURE = isSchwab ? 0.70 : 0.75
  const totalMarketValue = positions.reduce((s, p) => s + Math.abs(p.market_value ?? p.current_price * p.quantity), 0)
  if (totalMarketValue / equity > MAX_EXPOSURE) {
    return { trades_made: 0, message: `[${broker}] Exposure cap: $${totalMarketValue.toFixed(0)}/$${equity.toFixed(0)} (${(totalMarketValue/equity*100).toFixed(0)}% > ${MAX_EXPOSURE*100}%)` }
  }

  const heldSymbols = positions.map((p) => p.symbol)
  const alloc       = await getSleeveAllocation(db)

  // Pass broker so EMA scanner uses correct watchlist (core vs wide)
  // and Claude gets the right confidence gate (78% live, 68% paper)
  const { recommendations, regime, scanned, candidates } =
    await getRecommendations(equity, heldSymbols, pdt.day_trades_remaining, broker)

  // ── 3-tier dynamic market gate ────────────────────────────────────────────
  // Good (VIX<22, SPY above 200SMA) → base gate, full positions
  // Tough (VIX 22-28)               → gate +5pts, same positions
  // Bad  (VIX>28 or below 200SMA)   → gate +12pts (floor 65%), cap positions at 6
  const vix = regime.vix
  const aboveSma = regime.spy_above_200sma

  let marketTier: 'GOOD' | 'TOUGH' | 'BAD'
  let dynamicMinConf: number
  let dynamicMaxPos: number

  if (!aboveSma || vix > 28) {
    marketTier    = 'BAD'
    dynamicMinConf = Math.max(profile.min_confidence + 12, 65)
    dynamicMaxPos  = Math.min(profile.max_positions, 6)
  } else if (vix > 22) {
    marketTier    = 'TOUGH'
    dynamicMinConf = profile.min_confidence + 5
    dynamicMaxPos  = profile.max_positions
  } else {
    marketTier    = 'GOOD'
    dynamicMinConf = profile.min_confidence
    dynamicMaxPos  = profile.max_positions
  }

  if (positions.length >= dynamicMaxPos) {
    return { trades_made: 0, message: `[${broker}] Full ${marketTier}: ${positions.length}/${dynamicMaxPos} | VIX${vix.toFixed(0)}` }
  }

  // Load Pavan's active intentions — these shape every execution decision this tick
  const intentions = await getActiveIntentions().catch(() => [])
  const intentionMap = new Map(intentions.map((i) => [i.symbol, i]))
  const avoidSymbols = new Set(intentions.filter((i) => i.type === 'avoid').map((i) => i.symbol))

  // Telegram signal boost: symbols mentioned in recent Telegram trade signals
  // (last 4 hours) get +8 confidence points — channel confirms our own scan.
  const since = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
  const { data: tgRows } = await db
    .from('tb_alerts')
    .select('symbol')
    .in('type', ['BUY', 'SELL'])
    .gte('created_at', since)
    .not('symbol', 'is', null)
  const tgSymbols = new Set((tgRows ?? []).map((r) => r.symbol as string))

  // Rotation overlay: rank by confidence × category bias.
  // Paper mode: COLD categories get bias=0.5 (not filtered out) so we still collect data.
  // Live (Schwab): COLD categories are filtered out completely.
  // Telegram-confirmed symbols get +8 confidence bonus before ranking.
  const ranked = recommendations
    .filter((r) => !heldSymbols.includes(r.symbol))
    .filter((r) => !avoidSymbols.has(r.symbol))   // Pavan said avoid — never enter
    .map((r) => {
      const rawBias = biasForSymbol(r.symbol, rotation)
      const bias = !isSchwab && rawBias === 0 ? 0.4 : rawBias

      const intent = intentionMap.get(r.symbol)
      // Intention confidence boosts: buy_zone in range > watch_only > tg_alert
      let intentBoost = 0
      if (intent?.type === 'buy_zone' && intent.price_zone) {
        // Will get quote below — for now mark as high-intent; actual zone check happens on execution
        intentBoost = intent.urgency === 'high' ? 15 : 10
      } else if (intent?.type === 'watch_only') {
        intentBoost = 5
      } else if (tgSymbols.has(r.symbol)) {
        intentBoost = 8
      }

      return {
        rec: { ...r, confidence: Math.min(100, r.confidence + intentBoost) },
        bias,
        tg_confirmed: tgSymbols.has(r.symbol) || !!intent,
        intent,
      }
    })
    .filter((x) => isSchwab ? x.bias > 0 : true)
    .filter((x) => x.rec.confidence >= dynamicMinConf)
    .sort((a, b) => (b.rec.confidence * b.bias) - (a.rec.confidence * a.bias))

  let tradesMade = 0
  const openSlots = dynamicMaxPos - positions.length
  const reviewLimit = isSchwab ? openSlots : Math.max(openSlots, 25)

  for (const { rec, bias, tg_confirmed, intent } of ranked.slice(0, reviewLimit)) {
    const quote = isSchwab
      ? await SchwabBroker.getQuote(rec.symbol)
      : await AlpacaBroker.getQuote(rec.symbol)
    if (!quote || quote.price <= 0) continue

    // buy_zone intent: only execute if live price is actually inside Pavan's zone.
    // If price is outside zone → skip this tick, wait for the right entry point.
    if (intent?.type === 'buy_zone' && intent.price_zone) {
      const { low, high } = intent.price_zone
      if (quote.price < low || quote.price > high) continue  // not at the right price yet
    }

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
      const cat      = categoryLabel(rec.symbol)
      // Mark the intention as acted so we don't buy twice on the same signal
      if (intent) await markActed(rec.symbol, intent.type).catch(() => {})

      const intentNote = intent?.type === 'buy_zone' ? ' 🎯TG-zone' : intent?.type === 'watch_only' ? ' 👁TG-watch' : ''
      const tgNote   = tg_confirmed ? ` 📡TG${intentNote}` : ''
      const riskNote = ` | sleeve=${sleeve} cat=${cat} ema=${rec.ema_score}/10 claude=${rec.claude_conf}% oai=${rec.openai_conf}% stop=$${initialStop.toFixed(2)} target=$${target.toFixed(2)} stop_id=${stop_order_id ?? 'n/a'}${tgNote}`

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

      // SMS alert for real-money Schwab trades with 80%+ dual confidence
      await alertTradeEntered({
        broker: broker as 'schwab' | 'alpaca_paper',
        symbol: rec.symbol, qty: sizing.qty, price: quote.price,
        claude_conf: rec.claude_conf, openai_conf: rec.openai_conf,
        ema_score: rec.ema_score, reason: rec.reason,
        stop: initialStop, target,
      })
    }
  }

  // Pre-market alert: surface top setup found (even if not entered yet)
  if (tradesMade === 0 && ranked.length > 0) {
    const top = ranked[0].rec
    await alertPreMarket({
      setups_found: candidates,
      top_symbol: top.symbol,
      top_score: top.ema_score ?? 0,
      regime: regime.regime,
      vix: regime.vix,
    })
  }

  const hot = rotation.hottest ? ` Hot:${rotation.hottest}` : ''
  return {
    trades_made: tradesMade,
    message: `[${broker}] Market:${marketTier} VIX${vix.toFixed(0)} Gate:${dynamicMinConf}% MaxPos:${dynamicMaxPos}${hot} PDT:${pdt.day_trades_used}/3 Scanned:${scanned} Candidates:${candidates} Ranked:${ranked.length} Trades:${tradesMade}`,
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
