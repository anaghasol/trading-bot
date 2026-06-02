import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { getPerformanceStats } from '@/lib/performance'
import { BROKER_LABEL, IS_PAPER } from '@/lib/broker'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const days = parseInt(searchParams.get('days') ?? '30', 10)

  const stats = await getPerformanceStats(days)
  return NextResponse.json({ ...stats, broker: BROKER_LABEL, paper: IS_PAPER })
}
