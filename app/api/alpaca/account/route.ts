/**
 * GET /api/alpaca/account — full Alpaca paper account data
 * Returns balance, buying power, day P/L, equity from Alpaca directly.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

const BASE   = 'https://paper-api.alpaca.markets/v2'
const KEY_ID = process.env.ALPACA_KEY_ID!
const SECRET = process.env.ALPACA_SECRET_KEY!

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const res = await fetch(`${BASE}/account`, {
      headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET },
      cache: 'no-store',
    })
    if (!res.ok) return NextResponse.json({ error: 'Alpaca API error' }, { status: 200 })

    const a = await res.json() as Record<string, string | number>

    const equity      = parseFloat(String(a.equity      ?? a.portfolio_value ?? 0))
    const last_equity = parseFloat(String(a.last_equity ?? equity))
    const cash        = parseFloat(String(a.cash        ?? 0))
    const buying_power = parseFloat(String(a.buying_power ?? 0))
    const day_trade_buying_power = parseFloat(String(a.daytrading_buying_power ?? buying_power))
    const day_pnl     = equity - last_equity

    return NextResponse.json({
      account_value:          equity,
      cash,
      stock_buying_power:     buying_power,
      option_buying_power:    buying_power,
      day_trade_buying_power,
      day_pnl,
      day_pnl_pct:            last_equity > 0 ? (day_pnl / last_equity) * 100 : 0,
      daytrade_count:         Number(a.daytrade_count ?? 0),
      portfolio_value:        equity,
      raw: a,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 200 })
  }
}
