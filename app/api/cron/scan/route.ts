/**
 * CRON: /api/cron/scan — runs at 9:45 AM ET (entry window)
 * SWING MODE: picks 1-5 day holds, PDT-aware.
 *
 * Schedule: "15 14 * * 1-5" (9:15 AM ET = 14:15 UTC)
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder, getOrders, getQuote } from '@/lib/schwab'
import { getRecommendations } from '@/lib/ai-advisor'
import { analyzePdtStatus, SWING_CONFIG } from '@/lib/pdt'
import { isMarketOpen, isDailyLossExceeded, getPositionSize } from '@/lib/risk'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const start = Date.now()

  if (!isMarketOpen()) {
    return NextResponse.json({ status: 'skipped', reason: 'market_closed' })
  }

  try {
    const [positions, balance, orders] = await Promise.all([
      getPositions(),
      getAccountBalance(),
      getOrders(7),
    ])

    const activeBalance = balance ?? 2000
    const pdt = analyzePdtStatus(orders, activeBalance)

    // Log PDT status
    console.log(`[scan] PDT: ${pdt.day_trades_used}/3 used | Balance: $${activeBalance.toFixed(2)} | Positions: ${positions.length}/${SWING_CONFIG.max_positions}`)

    // Check daily loss limit
    const { data: account } = await db.from('tb_account').select('daily_pnl').order('id', { ascending: false }).limit(1).single()
    const dailyPnl = account?.daily_pnl ?? 0
    if (isDailyLossExceeded(dailyPnl, activeBalance)) {
      await db.from('tb_cron_log').insert({ job: 'scan', status: 'skipped', trades_made: 0, message: `Daily loss limit hit: $${dailyPnl.toFixed(2)}` })
      return NextResponse.json({ status: 'skipped', reason: 'daily_loss_limit', daily_pnl: dailyPnl })
    }

    if (positions.length >= SWING_CONFIG.max_positions) {
      await db.from('tb_cron_log').insert({ job: 'scan', status: 'skipped', trades_made: 0, message: `Full: ${positions.length}/${SWING_CONFIG.max_positions} positions` })
      return NextResponse.json({ status: 'skipped', reason: 'max_positions', positions: positions.length })
    }

    const heldSymbols = positions.map((p) => p.symbol)

    const { recommendations, regime, position_size_pct, scanned, candidates, learning_context } =
      await getRecommendations(activeBalance, heldSymbols, pdt.day_trades_remaining)

    let tradesMade = 0
    const openSlots = SWING_CONFIG.max_positions - positions.length

    for (const rec of recommendations.slice(0, openSlots)) {
      if (heldSymbols.includes(rec.symbol)) continue

      const quote = await getQuote(rec.symbol)
      if (!quote || quote.price <= 0) continue

      // Size position: use swing config, cap at 20% of balance as safety
      const sizePct = Math.min(position_size_pct, 0.20)
      const qty = getPositionSize(activeBalance, quote.price, sizePct)
      if (qty === 0) continue

      const cost = qty * quote.price
      if (cost > activeBalance * 0.35) continue  // never more than 35% in one position

      const order = await placeOrder(rec.symbol, qty, 'BUY')

      if (order.status === 'PLACED') {
        tradesMade++

        await db.from('tb_trades').insert({
          symbol: rec.symbol, action: 'BUY', quantity: qty,
          entry_price: quote.price, status: 'OPEN',
          strategy: rec.setup, reason: rec.reason,
          confidence: rec.confidence, regime: regime.regime,
          created_at: new Date().toISOString(),
        })

        await db.from('tb_alerts').insert({
          type: 'BUY',
          message: `SWING BUY ${qty} ${rec.symbol} @ $${quote.price.toFixed(2)} | Target +${rec.target_pct}% in ${rec.hold_days}d | ${rec.reason} (${rec.confidence}%)`,
          symbol: rec.symbol,
        })
      }
    }

    await db.from('tb_cron_log').insert({
      job: 'scan', status: 'success', trades_made: tradesMade,
      message: `Regime:${regime.regime} PDT:${pdt.day_trades_used}/3 Scanned:${scanned} Candidates:${candidates} Picks:${recommendations.length} Trades:${tradesMade} | ${learning_context.slice(0, 100)}`,
      duration_ms: Date.now() - start,
    })

    return NextResponse.json({
      status: 'ok', regime: regime.regime,
      pdt_used: pdt.day_trades_used, pdt_remaining: pdt.day_trades_remaining,
      scanned, candidates, picks: recommendations.length, trades_made: tradesMade,
      learning: learning_context,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'scan', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
