import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()
  const { data } = await db
    .from('tb_alerts')
    .select('type, symbol, message, created_at')
    .in('type', ['SUPERCYCLE', 'WATCHLIST'])
    .order('created_at', { ascending: false })
    .limit(60)

  const rows = data ?? []

  const parse = (row: { symbol: string; message: string; created_at: string }) => {
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(row.message) } catch { /* ignore */ }
    return { ticker: row.symbol, scanned_at: row.created_at, ...parsed }
  }

  const candidates = rows.filter(r => r.type === 'SUPERCYCLE').map(parse)
  const watchlist  = rows.filter(r => r.type === 'WATCHLIST').map(parse)

  return NextResponse.json({ candidates, watchlist })
}
