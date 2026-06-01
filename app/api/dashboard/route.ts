import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'
import { isMarketOpen } from '@/lib/risk'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()

  const [
    accountResult,
    tradesResult,
    alertsResult,
    dailySummaryResult,
    cronResult,
    pnlResult,
  ] = await Promise.all([
    db.from('tb_account').select('*').order('id', { ascending: false }).limit(1).single(),
    db.from('tb_trades').select('*').order('created_at', { ascending: false }).limit(20),
    db.from('tb_alerts').select('*').order('created_at', { ascending: false }).limit(10),
    db.from('tb_daily_summary').select('*').order('date', { ascending: false }).limit(7),
    db.from('tb_cron_log').select('*').order('created_at', { ascending: false }).limit(5),
    db.from('tb_pnl_snapshots').select('*').eq('date', new Date().toISOString().split('T')[0]).order('hour'),
  ])

  return NextResponse.json({
    account: accountResult.data,
    trades: tradesResult.data ?? [],
    alerts: alertsResult.data ?? [],
    daily_summary: dailySummaryResult.data ?? [],
    cron_log: cronResult.data ?? [],
    pnl_chart: pnlResult.data ?? [],
    market_open: isMarketOpen(),
  })
}
