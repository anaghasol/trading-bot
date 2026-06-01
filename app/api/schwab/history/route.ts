/**
 * GET /api/schwab/history — real order + transaction history from Schwab
 * This is the source of truth for trade activity.
 */
import { NextResponse } from 'next/server'
import { getOrders, getTransactions } from '@/lib/schwab'
import { getOrders as getRawOrders } from '@/lib/schwab'
import { analyzePdtStatus } from '@/lib/pdt'
import { getAccountBalance } from '@/lib/schwab'
import { createClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url    = new URL(req.url)
  const days   = parseInt(url.searchParams.get('days') ?? '30', 10)

  const [orders, transactions, balance] = await Promise.all([
    getOrders(Math.min(days, 60)),
    getTransactions(Math.min(days, 60)),
    getAccountBalance(),
  ])

  const pdt = analyzePdtStatus(orders, balance ?? 2000)

  // Compute P&L per completed round-trip (buy + sell same symbol)
  const pnlByRoundTrip: { symbol: string; pnl: number; pnl_pct: number; buy_date: string; sell_date: string; held_days: number }[] = []

  const buyMap = new Map<string, { price: number; qty: number; date: string }>()
  const sortedOrders = [...orders].sort((a, b) => new Date(a.entered_time).getTime() - new Date(b.entered_time).getTime())

  for (const o of sortedOrders) {
    if (o.instruction === 'BUY') {
      buyMap.set(o.symbol, { price: o.price, qty: o.filled_quantity, date: o.entered_time.split('T')[0] })
    } else if (o.instruction === 'SELL') {
      const buy = buyMap.get(o.symbol)
      if (buy) {
        const pnl = (o.price - buy.price) * Math.min(o.filled_quantity, buy.qty)
        const pnl_pct = ((o.price - buy.price) / buy.price) * 100
        const sell_date = o.entered_time.split('T')[0]
        const held_days = Math.round((new Date(sell_date).getTime() - new Date(buy.date).getTime()) / 86_400_000)
        pnlByRoundTrip.push({ symbol: o.symbol, pnl, pnl_pct, buy_date: buy.date, sell_date, held_days })
        buyMap.delete(o.symbol)
      }
    }
  }

  const totalPnl  = pnlByRoundTrip.reduce((s, t) => s + t.pnl, 0)
  const wins      = pnlByRoundTrip.filter((t) => t.pnl > 0)
  const losses    = pnlByRoundTrip.filter((t) => t.pnl <= 0)
  const winRate   = pnlByRoundTrip.length > 0 ? (wins.length / pnlByRoundTrip.length) * 100 : 0

  return NextResponse.json({
    orders,
    transactions,
    round_trips: pnlByRoundTrip.sort((a, b) => new Date(b.sell_date).getTime() - new Date(a.sell_date).getTime()),
    summary: {
      total_pnl: totalPnl,
      total_trades: pnlByRoundTrip.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: winRate,
      balance: balance ?? 0,
    },
    pdt,
  })
}
