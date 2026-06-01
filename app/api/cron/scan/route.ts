/**
 * CRON: /api/cron/scan — AI market scan + entry
 * Elite sizing: 1.2% equity risk per trade, 2.5% initial stop, 5% trail, 2:1 partial target.
 *
 * Schedule: 9:15 AM ET (morning entry) + 12:00 PM ET (midday entry)
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder, getOrders, getQuote } from '@/lib/schwab'
import { getRecommendations } from '@/lib/ai-advisor'
import { analyzePdtStatus, SWING_CONFIG } from '@/lib/pdt'
import { calculatePositionSize, isMarketOpen, isDailyLossExceeded } from '@/lib/risk'
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
    const [positions, balance, recentOrders] = await Promise.all([
      getPositions(),
      getAccountBalance(),
      getOrders(7),
    ])

    const equity = balance ?? 2000
    const pdt    = analyzePdtStatus(recentOrders, equity)

    const { data: account } = await db.from('tb_account').select('daily_pnl').order('id', { ascending: false }).limit(1).single()
    const dailyPnl = account?.daily_pnl ?? 0

    if (isDailyLossExceeded(dailyPnl, equity)) {
      await db.from('tb_cron_log').insert({ job: 'scan', status: 'skipped', trades_made: 0, message: `Daily loss limit. P&L: $${dailyPnl.toFixed(2)}` })
      return NextResponse.json({ status: 'skipped', reason: 'daily_loss_limit' })
    }

    if (positions.length >= SWING_CONFIG.max_positions) {
      await db.from('tb_cron_log').insert({ job: 'scan', status: 'skipped', trades_made: 0, message: `Full: ${positions.length}/${SWING_CONFIG.max_positions} positions` })
      return NextResponse.json({ status: 'skipped', reason: 'max_positions', count: positions.length })
    }

    const heldSymbols = positions.map((p) => p.symbol)

    const { recommendations, regime, position_size_pct, scanned, candidates, learning_context } =
      await getRecommendations(equity, heldSymbols, pdt.day_trades_remaining)

    let tradesMade = 0
    const openSlots = SWING_CONFIG.max_positions - positions.length

    for (const rec of recommendations.slice(0, openSlots)) {
      if (heldSymbols.includes(rec.symbol)) continue

      const quote = await getQuote(rec.symbol)
      if (!quote || quote.price <= 0) continue

      // Risk-based position sizing (1.2% equity risk, 2.5% stop)
      const sizing = calculatePositionSize(equity, quote.price)

      // Safety checks: don't put more than 35% in one position, must be able to buy at least 1 share
      if (sizing.qty === 0) continue
      if (sizing.qty * quote.price > equity * 0.35) {
        sizing.qty = Math.max(1, Math.floor((equity * 0.35) / quote.price))
      }

      // Make sure we have enough cash
      const totalAllocated = positions.reduce((s, p) => s + p.market_value, 0)
      const cashAvailable  = equity - totalAllocated
      if (sizing.qty * quote.price > cashAvailable * 0.95) continue

      const order = await placeOrder(rec.symbol, sizing.qty, 'BUY')

      if (order.status === 'PLACED') {
        tradesMade++

        // Store risk params in reason field if migration v3 not yet run
        const riskNote = ` | stop=$${sizing.initial_stop.toFixed(2)} target=$${sizing.target_price.toFixed(2)} risk=$${sizing.risk_dollars.toFixed(0)}`
        const tradeRow: Record<string, unknown> = {
          symbol:      rec.symbol,
          action:      'BUY',
          quantity:    sizing.qty,
          entry_price: quote.price,
          status:      'OPEN',
          strategy:    rec.setup,
          reason:      rec.reason + riskNote,
          confidence:  rec.confidence,
          regime:      regime.regime,
          created_at:  new Date().toISOString(),
        }
        // Conditionally add v3 columns (migration may not be run yet)
        try {
          const { error } = await db.from('tb_trades').insert({
            ...tradeRow,
            initial_stop_price:  sizing.initial_stop,
            peak_price:          quote.price,
            trailing_stop_price: quote.price * 0.95,
            target_price:        sizing.target_price,
            partial_exit_done:   false,
          })
          if (error?.code === 'PGRST204') {
            // Column doesn't exist yet, insert without v3 columns
            await db.from('tb_trades').insert(tradeRow)
          }
        } catch {
          await db.from('tb_trades').insert(tradeRow)
        }

        await db.from('tb_alerts').insert({
          type: 'BUY',
          message: `SWING BUY ${sizing.qty} ${rec.symbol} @ $${quote.price.toFixed(2)} | Risk $${sizing.risk_dollars.toFixed(0)} | Stop $${sizing.initial_stop.toFixed(2)} | Target $${sizing.target_price.toFixed(2)} | ${rec.reason} (${rec.confidence}% confident)`,
          symbol: rec.symbol,
        })
      }
    }

    await db.from('tb_cron_log').insert({
      job: 'scan', status: 'success', trades_made: tradesMade,
      message: `Regime:${regime.regime} PDT:${pdt.day_trades_used}/3 Scanned:${scanned} Candidates:${candidates} Picks:${recommendations.length} Placed:${tradesMade}`,
      duration_ms: Date.now() - start,
    })

    return NextResponse.json({
      status: 'ok', regime: regime.regime,
      pdt_used: pdt.day_trades_used, pdt_remaining: pdt.day_trades_remaining,
      equity, scanned, candidates, picks: recommendations.length, trades_made: tradesMade,
      learning: learning_context,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'scan', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
