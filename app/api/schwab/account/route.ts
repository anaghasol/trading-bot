import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'
import { getAccountSummary, getSchwabAuthStatus } from '@/lib/schwab'

const CACHE_KEY = 'schwab_account_cache'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()

  // Read cache once — used for both the TTL fast-path and the failure fallback
  const { data: cacheRow } = await db.from('tb_settings').select('value').eq('key', CACHE_KEY).single()
  let cached: Record<string, unknown> | null = null
  if (cacheRow?.value) {
    try { cached = JSON.parse(cacheRow.value) } catch { /* ignore */ }
  }

  // Fast path: serve cache if < 12s old — avoids hitting Schwab on every poll
  if (cached?.cached_at) {
    const ageMs = Date.now() - new Date(String(cached.cached_at)).getTime()
    if (ageMs < 12_000) return NextResponse.json({ ...cached, from_cache: true })
  }

  const [summary, authStatus] = await Promise.all([getAccountSummary(), getSchwabAuthStatus()])

  if (summary) {
    const cachePayload = { ...summary, auth_status: authStatus, cached_at: new Date().toISOString() }
    void db.from('tb_settings').upsert({ key: CACHE_KEY, value: JSON.stringify(cachePayload) })
    return NextResponse.json(cachePayload)
  }

  // Live call failed — return last known good data (marked stale)
  if (cached) return NextResponse.json({ ...cached, stale: true, auth_status: authStatus })

  return NextResponse.json({
    error: 'schwab_auth_expired',
    auth_status: authStatus,
    reauth_url: '/api/schwab/auth',
  }, { status: 200 })
}
