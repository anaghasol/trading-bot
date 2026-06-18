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
    .or('broker.eq.alpaca_paper,broker.is.null')
    .gte('closed_at', todayStart)
    .order('closed_at', { ascending: false })

  const { data: openTrades } = await db
    .from('tb_trades')
    .select('symbol, entry_price, strategy, reason, created_at')
    .eq('status', 'OPEN')
    .or('broker.eq.alpaca_paper,broker.is.null')

  const { data: alerts } = await db
    .from('tb_alerts')
    .select('type, symbol, message, created_at')
    .or('broker.eq.alpaca_paper,broker.is.null')
    .gte('created_at', todayStart)
    .order('created_at', { ascending: false })
    .limit(100)

  const { data: cronLogs } = await db
    .from('tb_cron_log')
    .select('job, status, message, trades_made, created_at')
    .gte('created_at', todayStart)
    .order('created_at', { ascending: false })
    .limit(50)

  const closed = closedTrades ?? []
  const totalRealizedPnl = closed.reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)
  const winners = closed.filter((t) => (t.pnl as number) > 0)
  const losers  = closed.filter((t) => (t.pnl as number) <= 0)
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealized_pnl, 0)

  const positionsWithMeta = positions.map((p) => {
    const trade = (openTrades ?? []).find((t) => t.symbol === p.symbol)
    return {
      symbol:         p.symbol,
      quantity:       p.quantity,
      entry_price:    p.avg_cost,
      current_price:  p.current_price,
      unrealized_pnl: p.unrealized_pnl,
      pnl_pct:        p.pnl_pct,
      market_value:   p.market_value,
      strategy:       trade?.strategy ?? null,
      entry_time:     trade?.created_at ?? null,
    }
  })

  const stopLossAlerts = (alerts ?? []).filter((a) => a.type === 'STOP_LOSS')
  const buyAlerts      = (alerts ?? []).filter((a) => a.type === 'BUY')
  const sellAlerts     = (alerts ?? []).filter((a) => a.type === 'SELL')
  const warnAlerts     = (alerts ?? []).filter((a) => a.type === 'WARN')

  const issues: string[] = []

  if (losers.length > winners.length && closed.length > 0) {
    issues.push(`More losers than winners today: ${losers.length} losses vs ${winners.length} wins`)
  }

  const bigLosses = closed.filter((t) => (t.pnl_pct as number) <= -5)
  if (bigLosses.length > 0) {
    issues.push(`${bigLosses.length} trades hit hard stop (>=-5%): ${bigLosses.map((t) => `${t.symbol} ${(t.pnl_pct as number).toFixed(1)}%`).join(', ')}`)
  }

  if (stopLossAlerts.length > 0) {
    issues.push(`${stopLossAlerts.length} stop-loss exits fired today`)
  }

  const errorLogs = (cronLogs ?? []).filter((l) => l.status === 'error')
  if (errorLogs.length > 0) {
    issues.push(`${errorLogs.length} cron errors today: ${errorLogs.map((l) => l.message).join(' | ')}`)
  }

  const reconciledAlerts = (alerts ?? []).filter((a) =>
    typeof a.message === 'string' && a.message.includes('auto-reconciled')
  )
  if (reconciledAlerts.length > 0) {
    issues.push(`${reconciledAlerts.length} positions auto-reconciled (broker stop fired without DB update): ${reconciledAlerts.map((a) => a.symbol).join(', ')}`)
  }

  const flatRecycles = (alerts ?? []).filter((a) =>
    typeof a.message === 'string' && a.message.includes('FLAT_RECYCLE')
  )
  if (flatRecycles.length > 0) {
    issues.push(`${flatRecycles.length} flat-recycle exits (stuck ±2% for 2+ days): ${flatRecycles.map((a) => a.symbol).join(', ')}`)
  }

  return NextResponse.json({
    date: today,
    balance,
    summary: {
      realized_pnl:   Math.round(totalRealizedPnl * 100) / 100,
      unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
      total_pnl:      Math.round((totalRealizedPnl + unrealizedPnl) * 100) / 100,
      trades_closed:  closed.length,
      winners:        winners.length,
      losers:         losers.length,
      win_rate:       closed.length > 0 ? Math.round((winners.length / closed.length) * 100) : null,
      open_positions: positions.length,
      buys_today:     buyAlerts.length,
      sells_today:    sellAlerts.length,
      stop_losses:    stopLossAlerts.length,
    },
    issues,
    closed_trades: closed.map((t) => ({
      symbol:      t.symbol,
      pnl:         Math.round(((t.pnl as number) ?? 0) * 100) / 100,
      pnl_pct:     Math.round(((t.pnl_pct as number) ?? 0) * 100) / 100,
      entry_price: t.entry_price,
      exit_price:  t.exit_price,
      strategy:    t.strategy,
      entry_time:  t.created_at,
      exit_time:   t.closed_at,
      days_held:   t.days_held,
      exit_reason: typeof t.reason === 'string'
        ? t.reason.split('|').pop()?.trim() ?? t.reason
        : null,
    })),
    open_positions: positionsWithMeta,
    recent_alerts: (alerts ?? []).slice(0, 30).map((a) => ({
      type:    a.type,
      symbol:  a.symbol,
      message: a.message,
      time:    a.created_at,
    })),
    cron_health: (cronLogs ?? []).slice(0, 10).map((l) => ({
      job:     l.job,
      status:  l.status,
      message: l.message,
      trades:  l.trades_made,
      time:    l.created_at,
    })),
    stop_loss_events: stopLossAlerts.map((a) => ({
      symbol:  a.symbol,
      message: a.message,
      time:    a.created_at,
    })),
    warnings: warnAlerts.map((a) => ({ message: a.message, time: a.created_at })),
  })
}
