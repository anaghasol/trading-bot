/**
 * CRON: /api/cron/scan — runs every 15 min during market hours
 * AI scans watchlist, picks high-conviction setups, places BUY orders.
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder, getQuote } from '@/lib/schwab'
import { getRecommendations } from '@/lib/ai-advisor'
import {
  isMarketOpen,
  isDailyLossExceeded,
  getPositionSize,
  MAX_POSITIONS,
} from '@/lib/risk'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function log(db: ReturnType<typeof createServiceClient>, job: string, status: string, trades_made: number, message: string) {
  await db.from('tb_cron_log').insert({ job, status, trades_made, message, created_at: new Date().toISOString() })
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const db = createServiceClient()

  if (!isMarketOpen()) {
    await log(db, 'scan', 'skipped', 0, 'Market closed')
    return NextResponse.json({ status: 'skipped', reason: 'market_closed' })
  }

  try {
    const [positions, balance] = await Promise.all([
      getPositions(),
      getAccountBalance(),
    ])

    const activeBalance = balance ?? 2000

    // Check daily loss limit
    const { data: account } = await db
      .from('tb_account')
      .select('daily_pnl')
      .order('id', { ascending: false })
      .limit(1)
      .single()

    const dailyPnl = account?.daily_pnl ?? 0
    if (isDailyLossExceeded(dailyPnl, activeBalance)) {
      await log(db, 'scan', 'skipped', 0, `Daily loss limit hit: $${dailyPnl.toFixed(2)}`)
      return NextResponse.json({ status: 'skipped', reason: 'daily_loss_limit' })
    }

    const heldSymbols = positions.map((p) => p.symbol)

    if (positions.length >= MAX_POSITIONS) {
      await log(db, 'scan', 'skipped', 0, `Max positions reached (${MAX_POSITIONS})`)
      return NextResponse.json({ status: 'skipped', reason: 'max_positions' })
    }

    const { recommendations, regime, position_size_pct, scanned, candidates } =
      await getRecommendations(activeBalance, heldSymbols)

    let tradesMade = 0
    const openSlots = MAX_POSITIONS - positions.length

    for (const rec of recommendations.slice(0, openSlots)) {
      if (heldSymbols.includes(rec.symbol)) continue

      const quote = await getQuote(rec.symbol)
      if (!quote || quote.price <= 0) continue

      const qty = getPositionSize(activeBalance, quote.price, position_size_pct)
      if (qty * quote.price > activeBalance * 0.20) continue

      const order = await placeOrder(rec.symbol, qty, 'BUY')

      if (order.status === 'PLACED') {
        tradesMade++

        await db.from('tb_trades').insert({
          symbol: rec.symbol,
          action: 'BUY',
          quantity: qty,
          entry_price: quote.price,
          status: 'OPEN',
          strategy: rec.setup,
          reason: rec.reason,
          confidence: rec.confidence,
          regime: regime.regime,
          created_at: new Date().toISOString(),
        })

        await db.from('tb_alerts').insert({
          type: 'BUY',
          message: `BUY ${qty} ${rec.symbol} @ $${quote.price.toFixed(2)} — ${rec.reason} (${rec.confidence}% confident)`,
          symbol: rec.symbol,
        })
      }
    }

    await log(
      db, 'scan', 'success', tradesMade,
      `Scanned ${scanned} symbols, ${candidates} candidates, ${recommendations.length} picks, ${tradesMade} trades. Regime: ${regime.regime}`
    )

    return NextResponse.json({
      status: 'ok',
      regime: regime.regime,
      scanned,
      candidates,
      picks: recommendations.length,
      trades_made: tradesMade,
      duration_ms: Date.now() - start,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await log(db, 'scan', 'error', 0, msg)
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
