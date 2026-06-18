/**
 * CRON: /api/cron/fast — 1-minute mechanical entry scan. ZERO Claude cost.
 *
 * Reads the candidate queue cached by the AI scan, checks live Alpaca quotes,
 * and immediately enters any candidate that has slot + exposure room.
 * Claude is never called here — AI already vetted these symbols.
 */
import { NextResponse } from 'next/server'
import * as AlpacaBroker from '@/lib/alpaca'
import { calculatePositionSize, isMarketOpen } from '@/lib/risk'
import { PROFILES } from '@/lib/strategy-profiles'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 30

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

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen())   return NextResponse.json({ ok: true, skipped: 'market_closed' })

  const db      = createServiceClient()
  const profile = PROFILES.alpaca_paper
  const broker  = 'alpaca_paper'

  // Respect engine on/off
  const { data: engineRow } = await db.from('tb_settings').select('value').eq('key', 'engine_alpaca_paper').single()
  if (engineRow?.value !== 'running') return NextResponse.json({ ok: true, skipped: 'engine_stopped' })

  // Read the candidate queue (written by AI scan after each 10-min run)
  const { data: queueRow } = await db.from('tb_settings').select('value').eq('key', 'fast_entry_queue').single()
  const queue: QueueItem[] = JSON.parse(queueRow?.value ?? '[]')

  // Discard candidates older than 30 min — market has moved, re-scan will refresh
  const fresh = queue.filter((c) => Date.now() - c.cached_at < 30 * 60 * 1000)
  if (fresh.length === 0) return NextResponse.json({ ok: true, skipped: 'queue_empty_or_stale' })

  // Account state — both calls in parallel
  const [equity, positions] = await Promise.all([
    AlpacaBroker.getAccountBalance().then((b) => b ?? 100_000),
    AlpacaBroker.getPositions(),
  ])

  const posSymbols = new Set(positions.map((p) => p.symbol))
  const totalValue = positions.reduce((s, p) => s + p.market_value, 0)
  let   exposure   = totalValue / equity

  const MAX_EXP = 0.90
  const MAX_POS = profile.max_positions ?? 18

  if (positions.length >= MAX_POS) return NextResponse.json({ ok: true, skipped: 'max_positions' })
  if (exposure >= MAX_EXP)         return NextResponse.json({ ok: true, skipped: 'exposure_cap' })

  // Per-position exposure cap: divide remaining room equally across open slots
  const slotsLeft     = MAX_POS - positions.length
  const perPositionCap = Math.min(0.08, (MAX_EXP - exposure) / Math.max(slotsLeft, 1))

  const entered: string[] = []
  const skipped: string[] = []

  for (const candidate of fresh) {
    if (positions.length + entered.length >= MAX_POS) break
    if (exposure >= MAX_EXP) break
    if (posSymbols.has(candidate.symbol)) { skipped.push(`${candidate.symbol}:open`); continue }

    const quote = await AlpacaBroker.getQuote(candidate.symbol)
    if (!quote || quote.price <= 0) { skipped.push(`${candidate.symbol}:no_quote`); continue }

    const sizing = calculatePositionSize(
      equity,
      quote.price,
      profile.initial_stop_pct,
      profile.risk_pct,
      perPositionCap,
    )
    if (sizing.qty < 1) { skipped.push(`${candidate.symbol}:qty_zero`); continue }

    const tradeCost = sizing.qty * quote.price
    if (exposure + tradeCost / equity > MAX_EXP) { skipped.push(`${candidate.symbol}:would_exceed`); continue }

    const { buy, stop_order_id } = await AlpacaBroker.placeBuyWithProtection(
      candidate.symbol, sizing.qty, profile.trail_pct * 100,  // trail_pct as percentage
    )

    if (buy.status === 'PLACED') {
      exposure += tradeCost / equity
      entered.push(candidate.symbol)
      posSymbols.add(candidate.symbol)  // prevent double-entry in same run

      const tradeRow: Record<string, unknown> = {
        symbol:      candidate.symbol,
        action:      'BUY',
        quantity:    sizing.qty,
        entry_price: quote.price,
        status:      'OPEN',
        strategy:    candidate.setup,
        reason:      `FastScan ema=${candidate.ema_score}/10 conf=${candidate.confidence}% | stop_id=${stop_order_id ?? 'n/a'}`,
        confidence:  candidate.confidence,
        created_at:  new Date().toISOString(),
      }
      const { error } = await db.from('tb_trades').insert({ ...tradeRow, broker })
      if (error?.code === 'PGRST204') await db.from('tb_trades').insert(tradeRow)

      void db.from('tb_alerts').insert({
        type: 'BUY', symbol: candidate.symbol, broker,
        message: `[FAST] BUY ${sizing.qty} ${candidate.symbol} @ $${quote.price.toFixed(2)} conf=${candidate.confidence}% ema=${candidate.ema_score}/10`,
      })
    } else {
      skipped.push(`${candidate.symbol}:order_failed`)
    }
  }

  // Remove entered symbols from queue so they're not re-entered next minute
  if (entered.length > 0) {
    const enteredSet = new Set(entered)
    const remaining  = fresh.filter((c) => !enteredSet.has(c.symbol))
    void db.from('tb_settings').upsert({ key: 'fast_entry_queue', value: JSON.stringify(remaining) })
  }

  return NextResponse.json({ ok: true, entered, skipped: skipped.slice(0, 5), queue_size: fresh.length })
}
