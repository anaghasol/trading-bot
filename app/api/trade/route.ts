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

  // Fetch live price for accurate entry_price recording
  let entryPrice = 0
  try {
    const qRes = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}&fields=regularMarketPrice`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (qRes.ok) {
      const qData = await qRes.json()
      entryPrice = qData?.quoteResponse?.result?.[0]?.regularMarketPrice ?? 0
    }
  } catch { /* non-fatal */ }

  await db.from('tb_alerts').insert({
    type: action,
    message: `Manual ${action}: ${qty} ${sym} via ${broker}${entryPrice ? ` @ $${entryPrice.toFixed(2)}` : ''} — placed from dashboard`,
    symbol: sym,
  })

  // Write to tb_trades so manual positions are tracked alongside engine trades
  if (action === 'BUY' && entryPrice > 0) {
    const tradeRow: Record<string, unknown> = {
      symbol: sym, action: 'BUY', quantity: qty,
      entry_price: entryPrice, status: 'OPEN',
      strategy: 'MANUAL', reason: `Manual buy from dashboard`,
      confidence: 0, created_at: new Date().toISOString(),
    }
    const { error } = await db.from('tb_trades').insert({ ...tradeRow, broker })
    if (error?.code === 'PGRST204') await db.from('tb_trades').insert(tradeRow)
  }

  return NextResponse.json(order)
}
