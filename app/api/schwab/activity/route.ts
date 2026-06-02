import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getOrders, getFundingEvents } from '@/lib/schwab'

// GET /api/schwab/activity?days=30
// Returns filled orders + funding events (deposits/withdrawals you made on schwab.com).
// Schwab cannot INITIATE funding via API — this only READS what you did there.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const days = Number(searchParams.get('days') ?? 30)

  const [orders, funding] = await Promise.all([
    getOrders(days).catch(() => []),
    getFundingEvents(Math.max(days, 90)).catch(() => []),
  ])

  const deposits = funding.filter((f) => f.amount > 0)
  return NextResponse.json({
    orders,
    funding,
    deposits,
    total_deposited: deposits.reduce((s, f) => s + f.amount, 0),
  })
}
