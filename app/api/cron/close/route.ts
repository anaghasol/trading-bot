/**
 * CRON: /api/cron/close — runs at 3:45 PM ET (19:45 UTC)
 * Closes ALL open positions and writes end-of-day summary.
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder } from '@/lib/schwab'
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

  const db = createServiceClient()
  const today = new Date().toISOString().split('T')[0]

  try {
    const [positions, balance] = await Promise.all([
      getPositions(),
      getAccountBalance(),
    ])

    let closed = 0
    let totalPnl = 0

    for (const pos of positions) {
      if (pos.quantity === 0) continue
      const action = pos.quantity > 0 ? 'SELL' : 'BUY'
      const order = await placeOrder(pos.symbol, Math.abs(pos.quantity), action)

      if (order.status === 'PLACED') {
        closed++
        totalPnl += pos.unrealized_pnl

        await db.from('tb_trades').update({
          status: 'CLOSED',
          exit_price: pos.current_price,
          pnl: pos.unrealized_pnl,
          pnl_pct: pos.pnl_pct,
          closed_at: new Date().toISOString(),
        })
          .eq('symbol', pos.symbol)
          .eq('status', 'OPEN')

        await db.from('tb_alerts').insert({
          type: 'INFO',
          message: `EOD CLOSE ${pos.symbol}: ${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}% | $${pos.unrealized_pnl.toFixed(2)}`,
          symbol: pos.symbol,
          pnl: pos.unrealized_pnl,
        })
      }
    }

    // Get today's closed trade stats
    const { data: todayTrades } = await db
      .from('tb_trades')
      .select('pnl, symbol')
      .gte('closed_at', `${today}T00:00:00Z`)
      .eq('status', 'CLOSED')

    const wins   = todayTrades?.filter((t) => t.pnl > 0).length ?? 0
    const losses = todayTrades?.filter((t) => t.pnl < 0).length ?? 0
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0

    const sorted = [...(todayTrades ?? [])].sort((a, b) => b.pnl - a.pnl)

    const { data: acct } = await db.from('tb_account').select('balance, total_pnl, id').order('id', { ascending: false }).limit(1).single()
    const startingBalance = (balance ?? 0) - totalPnl
    const totalPnlAllTime = (acct?.total_pnl ?? 0) + totalPnl

    // Upsert daily summary
    await db.from('tb_daily_summary').upsert(
      {
        date: today,
        starting_balance: startingBalance,
        ending_balance: balance ?? 0,
        daily_pnl: totalPnl,
        total_pnl: totalPnlAllTime,
        wins,
        losses,
        win_rate: Math.round(winRate * 10) / 10,
        best_trade: sorted[0]?.symbol ?? null,
        worst_trade: sorted.at(-1)?.symbol ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'date' }
    )

    // Reset daily P&L
    if (acct?.id) {
      await db.from('tb_account').update({
        balance: balance ?? 0,
        daily_pnl: 0,
        total_pnl: totalPnlAllTime,
        updated_at: new Date().toISOString(),
      }).eq('id', acct.id)
    }

    await db.from('tb_cron_log').insert({
      job: 'close',
      status: 'success',
      trades_made: closed,
      message: `EOD: Closed ${closed} positions. Daily P&L: $${totalPnl.toFixed(2)}. Win rate: ${winRate.toFixed(0)}%`,
    })

    return NextResponse.json({ status: 'ok', closed, daily_pnl: totalPnl, wins, losses, win_rate: winRate })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'close', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
