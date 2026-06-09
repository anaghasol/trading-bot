import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getAccountSummary, getSchwabAuthStatus } from '@/lib/schwab'

// GET /api/schwab/account  → full live balances for the dashboard rail.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [summary, authStatus] = await Promise.all([getAccountSummary(), getSchwabAuthStatus()])

  if (!summary) {
    return NextResponse.json({
      error: 'schwab_auth_expired',
      auth_status: authStatus,
      reauth_url: '/api/schwab/auth',
    }, { status: 200 })
  }

  // Include auth freshness so dashboard can warn before expiry
  return NextResponse.json({ ...summary, auth_status: authStatus })
}
