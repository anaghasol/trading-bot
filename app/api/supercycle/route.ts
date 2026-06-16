import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()
  const { data } = await db
    .from('tb_alerts')
    .select('symbol, message, created_at')
    .eq('type', 'SUPERCYCLE')
    .order('created_at', { ascending: false })
    .limit(20)

  const candidates = (data ?? []).map(row => {
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(row.message) } catch { /* ignore */ }
    return { ticker: row.symbol, scanned_at: row.created_at, ...parsed }
  })

  return NextResponse.json({ candidates })
}
