import { NextResponse } from 'next/server'
import { getPositions } from '@/lib/schwab'
import { createClient, createServiceClient } from '@/lib/supabase-server'

const CACHE_KEY = 'schwab_positions_cache'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()

  // Serve cache immediately if < 12s old — positions don't change faster than Schwab updates them
  const { data: cacheRow } = await db.from('tb_settings').select('value').eq('key', CACHE_KEY).single()
  if (cacheRow?.value) {
    try {
      const { positions, cached_at } = JSON.parse(cacheRow.value)
      if (Date.now() - new Date(cached_at).getTime() < 25_000) {
        return NextResponse.json({ positions, from_cache: true })
      }
    } catch { /* fall through to live */ }
  }

  const positions = await getPositions()
  void db.from('tb_settings').upsert({ key: CACHE_KEY, value: JSON.stringify({ positions, cached_at: new Date().toISOString() }) })
  return NextResponse.json({ positions })
}
