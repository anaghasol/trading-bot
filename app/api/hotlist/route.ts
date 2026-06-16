import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET() {
  const db = createServiceClient()

  // Stale after 90 min — if market's been open longer than that with no refresh, show nothing
  const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString()
  const { data } = await db
    .from('tb_alerts')
    .select('symbol, message, created_at')
    .eq('type', 'HOT_LIST')
    .gte('created_at', cutoff)
    .order('message->hot_score', { ascending: false })
    .limit(50)

  const hot = (data ?? []).map(row => {
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(row.message) } catch { /* ignore */ }
    return { symbol: row.symbol, updated_at: row.created_at, ...parsed }
  })

  return NextResponse.json({ hot, updated_at: data?.[0]?.created_at ?? null })
}
