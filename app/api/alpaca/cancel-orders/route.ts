import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

const BASE   = 'https://paper-api.alpaca.markets/v2'
const KEY_ID = process.env.ALPACA_KEY_ID!
const SECRET = process.env.ALPACA_SECRET_KEY!

function h() {
  return { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET }
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch all open orders
  const listRes = await fetch(`${BASE}/orders?status=open&limit=100`, {
    headers: h(), cache: 'no-store',
  })
  if (!listRes.ok) return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })

  const orders = await listRes.json() as Array<{ id: string; symbol: string; side: string; type: string }>
  const buyOrders = orders.filter((o) => o.side === 'buy')

  await Promise.all(
    buyOrders.map((o) =>
      fetch(`${BASE}/orders/${o.id}`, { method: 'DELETE', headers: h() })
    )
  )

  return NextResponse.json({ cancelled: buyOrders.length, symbols: buyOrders.map((o) => o.symbol) })
}
