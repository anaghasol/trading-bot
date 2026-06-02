import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getAccountSummary } from '@/lib/schwab'

// GET /api/schwab/account  → full live balances for the dashboard rail.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const summary = await getAccountSummary()
  if (!summary) return NextResponse.json({ error: 'no_schwab_connection' }, { status: 200 })
  return NextResponse.json(summary)
}
