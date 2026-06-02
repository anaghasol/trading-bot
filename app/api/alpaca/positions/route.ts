/**
 * GET /api/alpaca/positions — live positions from Alpaca paper account
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
    const res = await fetch(`${BASE}/positions`, {
      headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET },
      cache: 'no-store',
    })
    if (!res.ok) return NextResponse.json({ positions: [] })

    const raw = await res.json() as Record<string, string | number>[]
    const positions = raw.map((p) => ({
      symbol:        String(p.symbol),
      quantity:      parseFloat(String(p.qty ?? 0)),
      avg_cost:      parseFloat(String(p.avg_entry_price ?? 0)),
      current_price: parseFloat(String(p.current_price  ?? 0)),
      market_value:  parseFloat(String(p.market_value   ?? 0)),
      unrealized_pnl: parseFloat(String(p.unrealized_pl ?? 0)),
      unrealized_pnl_pct: parseFloat(String(p.unrealized_plpc ?? 0)) * 100,
      day_pnl:       parseFloat(String(p.unrealized_intraday_pl ?? 0)),
      pnl_pct:       parseFloat(String(p.unrealized_plpc ?? 0)) * 100,
      cost_basis:    parseFloat(String(p.cost_basis ?? 0)),
      asset_type:    'EQUITY' as const,
    }))

    return NextResponse.json({ positions })
  } catch (e) {
    return NextResponse.json({ positions: [], error: String(e) })
  }
}
