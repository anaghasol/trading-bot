import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'
import * as Schwab from '@/lib/schwab'
import * as Alpaca from '@/lib/alpaca'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { symbol, quantity, action, broker, orderType = 'MARKET', limitPrice } = body

  if (!symbol || !quantity || !action || !broker) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const sym = String(symbol).toUpperCase().trim()
  const qty = parseInt(String(quantity), 10)
  if (isNaN(qty) || qty <= 0) {
    return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })
  }
  if (!['BUY', 'SELL'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  let order
  if (broker === 'schwab') {
    order = await Schwab.placeOrder(sym, qty, action, orderType, limitPrice)
  } else {
    // alpaca_paper or alpaca_live
    order = await Alpaca.placeOrder(sym, qty, action, orderType, limitPrice)
  }

  if (order.status === 'FAILED') {
    return NextResponse.json({ error: order.error ?? 'Order failed' }, { status: 422 })
  }

  const db = createServiceClient()
  await db.from('tb_alerts').insert({
    type: action,
    message: `Manual ${action}: ${qty} ${sym} via ${broker} — placed from dashboard`,
    symbol: sym,
  })

  return NextResponse.json(order)
}
