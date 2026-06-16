import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'
import { getAccountSummary, getSchwabAuthStatus } from '@/lib/schwab'

const CACHE_KEY = 'schwab_account_cache'

// GET /api/schwab/account → full live balances for the dashboard rail.
// When Schwab token is mid-refresh (30-min cycle), returns last cached summary
// instead of zeros — dashboard never goes blank due to transient token expiry.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()

  const [summary, authStatus] = await Promise.all([getAccountSummary(), getSchwabAuthStatus()])

  if (summary) {
    // Live data succeeded — cache it and return
    const cachePayload = { ...summary, auth_status: authStatus, cached_at: new Date().toISOString() }
    void db.from('tb_settings').upsert({ key: CACHE_KEY, value: JSON.stringify(cachePayload) })
    return NextResponse.json(cachePayload)
  }

  // Live call failed (transient token expiry or Schwab outage) — return cached data
  const { data: cacheRow } = await db.from('tb_settings').select('value').eq('key', CACHE_KEY).single()
  if (cacheRow?.value) {
    try {
      const cached = JSON.parse(cacheRow.value)
      // Mark as stale so dashboard can show a subtle indicator
      return NextResponse.json({ ...cached, stale: true, auth_status: authStatus })
    } catch { /* fall through to error */ }
  }

  // No cache either — true auth failure (refresh token expired)
  return NextResponse.json({
    error: 'schwab_auth_expired',
    auth_status: authStatus,
    reauth_url: '/api/schwab/auth',
  }, { status: 200 })
}
