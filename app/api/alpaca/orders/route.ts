/**
 * GET /api/alpaca/orders?days=7 — order history from Alpaca paper account
 * Used by the dashboard Activity section when in paper mode.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

const BASE   = 'https://paper-api.alpaca.markets/v2'
const KEY_ID = process.env.ALPACA_KEY_ID!
const SECRET = process.env.ALPACA_SECRET_KEY!

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const days   = parseInt(searchParams.get('days') ?? '7', 10)
  const after  = new Date(Date.now() - days * 86_400_000).toISOString()

  try {
    const res = await fetch(
      `${BASE}/orders?status=all&after=${after}&limit=100&direction=desc`,
      { headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET }, cache: 'no-store' }
    )
    if (!res.ok) return NextResponse.json({ orders: [] })

    const raw = await res.json() as Record<string, string | number | null>[]
    const orders = raw.map((o) => ({
      order_id:        String(o.id ?? ''),
      symbol:          String(o.symbol ?? ''),
      instruction:     String(o.side ?? 'buy').toUpperCase(),
      quantity:        parseFloat(String(o.qty ?? 0)),
      filled_quantity: parseFloat(String(o.filled_qty ?? 0)),
      price:           parseFloat(String(o.filled_avg_price ?? o.limit_price ?? 0)),
      status:          String(o.status ?? '').toUpperCase(),
      entered_time:    String(o.submitted_at ?? ''),
      close_time:      o.filled_at ? String(o.filled_at) : null,
      order_type:      String(o.type ?? 'market').toUpperCase(),
    }))

    return NextResponse.json({ orders })
  } catch (e) {
    return NextResponse.json({ orders: [], error: String(e) })
  }
}
