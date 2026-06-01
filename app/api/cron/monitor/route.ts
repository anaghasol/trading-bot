/**
 * CRON: /api/cron/monitor — runs every 5 min during market hours
 * Checks all open positions, applies stop-loss and trailing stop rules.
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder } from '@/lib/schwab'
import { checkExitCondition, isMarketOpen, isDailyLossExceeded } from '@/lib/risk'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isMarketOpen()) {
    return NextResponse.json({ status: 'skipped', reason: 'market_closed' })
  }

  const db = createServiceClient()
  const start = Date.now()

  try {
    const [positions, balance] = await Promise.all([
      getPositions(),
      getAccountBalance(),
    ])

    if (positions.length === 0) {
      return NextResponse.json({ status: 'ok', positions: 0, closed: 0 })
    }

    const activeBalance = balance ?? 2000
    let closed = 0
    const statuses: string[] = []

    // Fetch stored peak_pnl for each open position
    const { data: openTrades } = await db
      .from('tb_trades')
      .select('symbol, peak_pnl, id')
      .eq('status', 'OPEN')

    const peakBySymbol: Record<string, { id: number; peak: number }> = {}
    for (const t of openTrades ?? []) {
      peakBySymbol[t.symbol] = { id: t.id, peak: t.peak_pnl ?? 0 }
    }

    for (const pos of positions) {
      const storedPeak = peakBySymbol[pos.symbol]?.peak ?? 0
      const tradeId = peakBySymbol[pos.symbol]?.id

      const { shouldExit, reason, updatedPeakPnl } = checkExitCondition(pos, storedPeak)

      // Update peak if it increased
      if (tradeId && updatedPeakPnl > storedPeak) {
        await db.from('tb_trades').update({ peak_pnl: updatedPeakPnl }).eq('id', tradeId)
      }

      statuses.push(`${pos.symbol}: ${reason}`)

      if (shouldExit) {
        const action = pos.quantity > 0 ? 'SELL' : 'BUY'
        const order = await placeOrder(pos.symbol, Math.abs(pos.quantity), action)

        if (order.status === 'PLACED') {
          closed++
          const pnl = pos.unrealized_pnl

          if (tradeId) {
            await db.from('tb_trades').update({
              status: 'CLOSED',
              exit_price: pos.current_price,
              pnl,
              pnl_pct: pos.pnl_pct,
              closed_at: new Date().toISOString(),
            }).eq('id', tradeId)
          }

          // Update daily P&L in account
          const { data: acct } = await db
            .from('tb_account')
            .select('daily_pnl, id')
            .order('id', { ascending: false })
            .limit(1)
            .single()

          const newDailyPnl = (acct?.daily_pnl ?? 0) + pnl
          if (acct?.id) {
            await db.from('tb_account').update({ daily_pnl: newDailyPnl }).eq('id', acct.id)
          }

          const alertType = pnl >= 0 ? 'SELL' : 'STOP_LOSS'
          await db.from('tb_alerts').insert({
            type: alertType,
            message: `CLOSED ${pos.symbol}: ${reason} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pos.pnl_pct.toFixed(1)}%)`,
            symbol: pos.symbol,
            pnl,
          })

          if (isDailyLossExceeded(newDailyPnl, activeBalance)) {
            await db.from('tb_alerts').insert({
              type: 'INFO',
              message: `⚠ Daily loss limit reached (${((newDailyPnl / activeBalance) * 100).toFixed(1)}%). Trading paused for today.`,
            })
          }
        }
      }
    }

    // Save hourly P&L snapshot
    const etHour = parseInt(
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
      10
    )
    const { data: acctFinal } = await db.from('tb_account').select('daily_pnl').order('id', { ascending: false }).limit(1).single()
    await db.from('tb_pnl_snapshots').upsert({
      date: new Date().toISOString().split('T')[0],
      hour: etHour,
      balance: activeBalance,
      daily_pnl: acctFinal?.daily_pnl ?? 0,
    }, { onConflict: 'date,hour' })

    await db.from('tb_cron_log').insert({
      job: 'monitor',
      status: 'success',
      trades_made: closed,
      message: `Monitored ${positions.length} positions. Closed: ${closed}. ${statuses.join(' | ')}`,
      duration_ms: Date.now() - start,
    })

    return NextResponse.json({
      status: 'ok',
      positions_monitored: positions.length,
      closed,
      positions_status: statuses,
      duration_ms: Date.now() - start,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'monitor', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
