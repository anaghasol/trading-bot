import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

function isTgTrade(reason: string | null): boolean {
  const r = (reason ?? '').toLowerCase()
  return r.includes('tg:') || r.includes('sf essential') || r.includes('sf_essential')
}

export async function GET() {
  const db = createServiceClient()

  const { data, error } = await db
    .from('tb_trades')
    .select('id, symbol, broker, action, quantity, entry_price, exit_price, stop_loss, target_price, confidence, status, pnl, pnl_pct, reason, created_at, closed_at')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ trades: [] })

  const trades = (data ?? []).map((t) => ({
    ...t,
    source: isTgTrade(t.reason) ? 'sf_trades' : 'ai_scan',
  }))

  return NextResponse.json({ trades }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
