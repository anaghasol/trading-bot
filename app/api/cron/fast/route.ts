/**
 * CRON: /api/cron/fast — 1-minute mechanical entry scan. ZERO Claude cost.
 *
 * Two entry sources every minute:
 *   1. fast_entry_queue — candidates vetted by the 10-min AI scan (highest confidence)
 *   2. Volume surge scanner — ANY stock with 2× intraday volume pace vs yesterday
 *      that is also making a positive move. Pure momentum, no AI cost.
 *
 * Together these keep 40 positions filled and capital deployed at all times.
 */
import { NextResponse } from 'next/server'
import * as AlpacaBroker from '@/lib/alpaca'
import { calculatePositionSize, isMarketOpen } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 30

// Surge universe — quality names only, no leveraged ETFs (too volatile, decay badly)
const SURGE_UNIVERSE = [
  // Mega-cap momentum
  'NVDA', 'AMD', 'TSLA', 'META', 'AMZN', 'MSFT', 'GOOGL', 'AAPL', 'NFLX', 'ORCL',
  // High-beta tech
  'CRM', 'SNOW', 'PLTR', 'ARM', 'SMCI', 'CRWD', 'PANW', 'ZS', 'DDOG', 'NET',
  'APP', 'RDDT', 'RKLB', 'SOUN', 'MELI', 'SHOP', 'SQ', 'PYPL', 'UBER', 'LYFT',
  'ABNB', 'DASH', 'SNAP', 'PINS', 'TTD', 'ROKU', 'SPOT',
  // Crypto proxy (NOT leveraged ETFs)
  'COIN', 'HOOD', 'MSTR', 'RIOT', 'MARA', 'CLSK', 'IREN', 'CIFR', 'HUT', 'BTBT',
  // Biotech momentum
  'MRNA', 'BNTX', 'NVAX', 'SAVA', 'RXRX', 'SRPT', 'RARE', 'BEAM', 'EDIT',
  // EV / clean energy
  'RIVN', 'LCID', 'NIO', 'CHPT', 'PLUG', 'BE', 'BLNK', 'EVGO',
  // Finance / fintech
  'SOFI', 'UPST', 'AFRM', 'NU', 'ALLY', 'LC',
  // Semiconductors
  'AVGO', 'QCOM', 'MRVL', 'AMAT', 'LRCX', 'KLAC', 'ENTG', 'ON',
  // Momentum wildcards
  'GME', 'BBAI', 'JOBY', 'ACHR', 'LUNR', 'OKLO', 'SMR',
  // Large-cap RS leaders
  'GS', 'JPM', 'MS', 'V', 'MA', 'IBKR',
]

interface QueueItem {
  symbol:     string
  confidence: number
  ema_score:  number
  hold_mode:  string
  setup:      string
  cached_at:  number
}

function authorized(req: Request) {
  return req.headers.get('Authorization') === `Bearer ${process.env.CRON_SECRET}`
}

/** ET market open time today as UTC ms */
function marketOpenTodayMs(): number {
  const now = new Date()
  const etOffset = -4  // EDT (adjust to -5 for EST if needed)
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60
  const etHour = (utcHour + 24 + etOffset) % 24
  const msSinceOpen = Math.max(0.25, etHour - 9.5) * 3600_000  // at least 15 min
  return Date.now() - msSinceOpen
}

/** Detect volume surge candidates from the wide universe.
 *  Surge = today's volume pace (shares/hour) > 2× yesterday's average hourly pace
 *  AND price is positive on the day. */
async function getVolumeSurgeCandidates(
  posSymbols: Set<string>
): Promise<Array<{ symbol: string; surgeMult: number; changePct: number }>> {
  const eligible = SURGE_UNIVERSE.filter((s) => !posSymbols.has(s))
  // Batch in chunks of 40 (Alpaca snapshot limit)
  const chunks: string[][] = []
  for (let i = 0; i < eligible.length; i += 40) chunks.push(eligible.slice(i, i + 40))

  const results: Array<{ symbol: string; surgeMult: number; changePct: number }> = []
  const hoursElapsed = Math.max(0.25, (Date.now() - marketOpenTodayMs()) / 3_600_000)

  for (const chunk of chunks) {
    const snaps = await AlpacaBroker.getSnapshots(chunk)
    for (const sym of chunk) {
      const snap = snaps[sym]
      if (!snap?.dailyBar || !snap?.prevDailyBar) continue
      const todayVol = snap.dailyBar.v ?? 0
      const prevVol  = snap.prevDailyBar.v ?? 0
      if (todayVol < 100_000 || prevVol < 50_000) continue  // thin stocks: skip

      const todayPace = todayVol / hoursElapsed         // shares/hour today
      const prevPace  = prevVol  / 6.5                  // avg shares/hour yesterday
      const surgeMult = todayPace / Math.max(prevPace, 1)

      const prevClose = snap.prevDailyBar.c ?? 0
      const todayLast = snap.dailyBar.c ?? snap.latestTrade?.p ?? 0
      const changePct = prevClose > 0 ? ((todayLast - prevClose) / prevClose) * 100 : 0

      // 2.0× volume surge + meaningful positive move — filters noise
      if (surgeMult >= 2.0 && changePct > 0.5) {
        results.push({ symbol: sym, surgeMult, changePct })
      }
    }
  }

  // Best surges first — return up to 15 (was 8) so fast scan fills more slots per cycle
  return results.sort((a, b) => b.surgeMult - a.surgeMult).slice(0, 15)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen())   return NextResponse.json({ ok: true, skipped: 'market_closed' })

  const db      = createServiceClient()
  const profile = PROFILES.alpaca_paper
  const broker  = 'alpaca_paper'

  const { data: engineRow } = await db.from('tb_context').select('value').eq('key', 'engine_alpaca').single()
  if (engineRow?.value === 'stopped') return NextResponse.json({ ok: true, skipped: 'engine_stopped' })

  // Daily MOMENTUM_SURGE cap — prevent churn filling all slots with low-quality entries
  const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00Z'
  const { data: todaySurges } = await db.from('tb_trades')
    .select('id')
    .eq('broker', 'alpaca_paper').eq('strategy', 'MOMENTUM_SURGE').eq('action', 'BUY')
    .gte('created_at', todayStart)
  const surgeCountToday = todaySurges?.length ?? 0
  const MAX_SURGE_DAY = 8   // max 8 momentum surge entries per day
  if (surgeCountToday >= MAX_SURGE_DAY) {
    return NextResponse.json({ ok: true, skipped: 'surge_daily_cap', count: surgeCountToday })
  }

  // Read AI-vetted candidate queue
  const { data: queueRow } = await db.from('tb_settings').select('value').eq('key', 'fast_entry_queue').single()
  const queue: QueueItem[] = JSON.parse(queueRow?.value ?? '[]')
  const fresh = queue.filter((c) => Date.now() - c.cached_at < 30 * 60 * 1000)

  // Account state
  const [equity, positions] = await Promise.all([
    AlpacaBroker.getAccountBalance().then((b) => b ?? 100_000),
    AlpacaBroker.getPositions(),
  ])

  const posSymbols = new Set(positions.map((p) => p.symbol))
  const totalValue = positions.reduce((s, p) => s + Math.abs(p.market_value), 0)
  let   exposure   = totalValue / equity

  const MAX_EXP = 0.95   // deploy up to 95% of capital — use it all
  const MAX_POS = profile.max_positions  // 40

  if (positions.length >= MAX_POS) return NextResponse.json({ ok: true, skipped: 'max_positions', count: positions.length })
  if (exposure >= MAX_EXP)         return NextResponse.json({ ok: true, skipped: 'exposure_cap', pct: (exposure * 100).toFixed(1) })

  // Volume surge candidates (parallel with any other prep)
  const surgePromise = getVolumeSurgeCandidates(posSymbols)

  const slotsLeft      = MAX_POS - positions.length
  const perPositionCap = Math.min(0.05, (MAX_EXP - exposure) / Math.max(slotsLeft, 1))

  const entered: string[] = []
  const skipped: string[] = []

  // Helper: size + enter one symbol
  async function tryEnter(symbol: string, label: string, conf: number, setup: string): Promise<boolean> {
    if (positions.length + entered.length >= MAX_POS) return false
    if (exposure >= MAX_EXP) return false
    if (posSymbols.has(symbol)) return false

    const quote = await AlpacaBroker.getQuote(symbol)
    if (!quote || quote.price <= 0) { skipped.push(`${symbol}:no_quote`); return false }

    const sizing = calculatePositionSize(equity, quote.price, profile.initial_stop_pct, profile.risk_pct, perPositionCap)
    if (sizing.qty < 1) { skipped.push(`${symbol}:qty_zero`); return false }

    const tradeCost = sizing.qty * quote.price
    if (exposure + tradeCost / equity > MAX_EXP) { skipped.push(`${symbol}:cap`); return false }

    const { buy, stop_order_id } = await AlpacaBroker.placeBuyWithProtection(
      symbol, sizing.qty, profile.trail_pct * 100,
    )
    if (buy.status !== 'PLACED') { skipped.push(`${symbol}:rejected`); return false }

    exposure += tradeCost / equity
    entered.push(symbol)
    posSymbols.add(symbol)

    const tradeRow: Record<string, unknown> = {
      symbol, action: 'BUY', quantity: sizing.qty, entry_price: quote.price,
      status: 'OPEN', strategy: setup,
      reason: `${label} conf=${conf}% stop=$${(quote.price * (1 - profile.initial_stop_pct)).toFixed(2)} stop_id=${stop_order_id ?? 'n/a'}`,
      confidence: conf, created_at: new Date().toISOString(),
    }
    const { error } = await db.from('tb_trades').insert({ ...tradeRow, broker })
    if (error?.code === 'PGRST204') await db.from('tb_trades').insert(tradeRow)
    void db.from('tb_alerts').insert({
      type: 'BUY', symbol, broker,
      message: `[${label}] BUY ${sizing.qty} ${symbol} @ $${quote.price.toFixed(2)} conf=${conf}%`,
    })
    return true
  }

  // Pass 1: AI-vetted queue (highest quality — enter these first)
  for (const candidate of fresh.sort((a, b) => b.confidence - a.confidence)) {
    await tryEnter(candidate.symbol, 'FAST', candidate.confidence, candidate.setup)
    if (entered.length + positions.length >= MAX_POS || exposure >= MAX_EXP) break
  }

  // Pass 2: Volume surge (real-time movers — enter any remaining slots)
  const surges = await surgePromise
  for (const surge of surges) {
    if (entered.length + positions.length >= MAX_POS || exposure >= MAX_EXP) break
    await tryEnter(surge.symbol, `SURGE×${surge.surgeMult.toFixed(1)}`, 60, 'MOMENTUM_SURGE')
  }

  // Remove entered symbols from queue
  if (entered.length > 0) {
    const enteredSet = new Set(entered)
    const remaining  = fresh.filter((c) => !enteredSet.has(c.symbol))
    void db.from('tb_settings').upsert({ key: 'fast_entry_queue', value: JSON.stringify(remaining) })
  }

  return NextResponse.json({
    ok: true, entered, skipped: skipped.slice(0, 10),
    queue_size: fresh.length, surge_found: surges.length,
    positions: positions.length + entered.length, exposure: (exposure * 100).toFixed(1) + '%',
  })
}
