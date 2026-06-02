import { NextResponse } from 'next/server'
import { placeOrder } from '@/lib/broker'
import { createClient, createServiceClient } from '@/lib/supabase-server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { symbol, quantity, action } = body

  if (!symbol || !quantity || !action) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const order = await placeOrder(symbol, parseInt(quantity, 10), action)

  if (order.status === 'PLACED') {
    const db = createServiceClient()
    await db.from('tb_alerts').insert({
      type: action,
      message: `Manual ${action}: ${quantity} ${symbol} — placed via dashboard`,
      symbol,
    })
  }

  return NextResponse.json(order)
}
