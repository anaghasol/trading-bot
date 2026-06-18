import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import * as AlpacaBroker from '@/lib/alpaca'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()
  const today = new Date().toISOString().split('T')[0]
  const todayStart = today + 'T00:00:00Z'

  const [positions, balance] = await Promise.all([
    AlpacaBroker.getPositions(),
    AlpacaBroker.getAccountBalance(),
  ])

  const { data: closedTrades } = await db
    .from('tb_trades')
    .select('symbol, entry_price, exit_price, pnl, pnl_pct, strategy, reason, created_at, closed_at, days_held')
    .eq('status', 'CLOSED')
    .gte('closed_at', todayStart)
    .or('broker.eq.alpaca_paper,broker.is.null')
    .order('closed_at', { ascending: false })

  const { data: openTrades } = await db
    .from('tb_trades')
    .select('symbol, entry_price, strategy, reason, created_at')
    .eq('status', 'OPEN')
    .or('broker.eq.alpaca_paper,broker.is.null')

  const { data: alerts } = await db
    .from('tb_alerts')
    .select('type, symbol, message, created_at')
    .gte('created_at', todayStart)
    .or('broker.eq.alpaca_paper,broker.is.null')
    .order('created_at', { ascending: false })
    .limit(100)

  const { data: snapshots } = await db
    .from('tb_pnl_snapshots')
    .select('hour, daily_pnl, balance')
    .eq('date', today)
    .or('broker.eq.alpaca_paper,broker.is.null')
    .order('hour', { ascending: true })

  const trades = closedTrades ?? []
  const totalRealizedPnl = trades.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)
  const winners = trades.filter((t) => (t.pnl as number) > 0)
  const losers  = trades.filter((t) => (t.pnl as number) <= 0)
  const stopLossHits = (alerts ?? []).filter((a) => a.type === 'STOP_LOSS')
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealized_pnl, 0)

  const openWithPnl = positions.map((p) => ({
    symbol:        p.symbol,
    quantity:      p.quantity,
    entry:         p.avg_cost,
    current:       p.current_price,
    unrealized:    p.unrealized_pnl,
    pnl_pct:       p.pnl_pct,
    asset_type:    p.asset_type,
  }))

  const diagnosis: string[] = []
  for (const t of trades) {
    const pnl = t.pnl as number
    const reason = String(t.reason ?? '')
    if (pnl < 0 && reason.includes('INITIAL_STOP')) {
      diagnosis.push(`${t.symbol}: hit initial stop at $${t.exit_price} (entry $${t.entry_price}) — loss ${(t.pnl_pct as number).toFixed(1)}%`)
    } else if (pnl < 0 && reason.includes('TRAILING_STOP')) {
      diagnosis.push(`${t.symbol}: trailing stop triggered — gave back gains, net ${(t.pnl_pct as number).toFixed(1)}%`)
    } else if (pnl < 0 && reason.includes('FLAT_RECYCLE')) {
      diagnosis.push(`${t.symbol}: recycled after going flat — small loss ${(t.pnl_pct as number).toFixed(1)}%`)
    } else if (pnl < 0 && reason.includes('HARD STOP')) {
      diagnosis.push(`${t.symbol}: hit hard stop (-5%) — loss ${(t.pnl_pct as number).toFixed(1)}%`)
    } else if (pnl < 0) {
      diagnosis.push(`${t.symbol}: closed at loss ${(t.pnl_pct as number).toFixed(1)}% — reason: ${reason.slice(0, 80)}`)
    }
  }

  return NextResponse.json({
    date: today,
    broker: 'alpaca_paper',
    balance,
    summary: {
      total_realized_pnl:   Math.round(totalRealizedPnl * 100) / 100,
      unrealized_pnl:       Math.round(unrealizedPnl * 100) / 100,
      total_pnl:            Math.round((totalRealizedPnl + unrealizedPnl) * 100) / 100,
      trades_closed:        trades.length,
      winners:              winners.length,
      losers:               losers.length,
      win_rate:             trades.length > 0 ? Math.round((winners.length / trades.length) * 100) : 0,
      stop_loss_hits:       stopLossHits.length,
      open_positions:       positions.length,
    },
    closed_trades:   trades,
    open_positions:  openWithPnl,
    stop_losses:     stopLossHits,
    pnl_curve:       snapshots ?? [],
    diagnosis,
    all_alerts:      (alerts ?? []).slice(0, 50),
  })
}
