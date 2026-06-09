import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getAccountHash, getStoredTokens } from '@/lib/schwab'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [hash, tokens] = await Promise.all([getAccountHash(), getStoredTokens()])
  if (!hash || !tokens) return NextResponse.json({ error: 'no_auth' })

  const res = await fetch(
    `https://api.schwabapi.com/trader/v1/accounts/${hash}?fields=positions`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  )
  if (!res.ok) return NextResponse.json({ error: `schwab_${res.status}`, body: await res.text() })

  const data = await res.json() as Record<string, unknown>
  const sa = (data.securitiesAccount as Record<string, unknown>) ?? {}

  return NextResponse.json({
    currentBalances:   sa.currentBalances,
    projectedBalances: sa.projectedBalances,
    initialBalances:   sa.initialBalances,
    positions_count:   Array.isArray(sa.positions) ? sa.positions.length : 0,
  })
}
