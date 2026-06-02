import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'
import { isMarketOpen } from '@/lib/risk'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const broker = searchParams.get('broker') ?? 'all'

  const db = createServiceClient()

  // Build trade queries — filter by broker if column exists
  const tradesQ  = db.from('tb_trades').select('*').order('created_at', { ascending: false }).limit(20)
  const alertsQ  = db.from('tb_alerts').select('*').order('created_at', { ascending: false }).limit(15)

  const [
    accountResult, tradesResult, alertsResult,
    dailySummaryResult, cronResult, pnlResult, engineResult,
  ] = await Promise.all([
    db.from('tb_account').select('*').order('id', { ascending: false }).limit(1).single(),
    tradesQ,
    alertsQ,
    db.from('tb_daily_summary').select('*').order('date', { ascending: false }).limit(7),
    db.from('tb_cron_log').select('*').order('created_at', { ascending: false }).limit(8),
    db.from('tb_pnl_snapshots').select('*').eq('date', new Date().toISOString().split('T')[0]).order('hour'),
    db.from('tb_context').select('key, value').in('key', ['engine_schwab', 'engine_alpaca']),
  ])

  // Filter by broker if column exists in returned data
  let trades = tradesResult.data ?? []
  let alerts = alertsResult.data ?? []

  if (broker !== 'all') {
    trades = trades.filter((t) => !t.broker || t.broker === broker)
    alerts = alerts.filter((a) => !a.broker || a.broker === broker)
  }

  const engineCtx = engineResult.data ?? []
  const engineStatus = {
    schwab:       engineCtx.find((r) => r.key === 'engine_schwab')?.value  ?? 'running',
    alpaca_paper: engineCtx.find((r) => r.key === 'engine_alpaca')?.value  ?? 'running',
  }

  return NextResponse.json({
    account:       accountResult.data,
    trades,
    alerts,
    daily_summary: dailySummaryResult.data ?? [],
    cron_log:      cronResult.data ?? [],
    pnl_chart:     pnlResult.data ?? [],
    market_open:   isMarketOpen(),
    engine_status: engineStatus,
    broker_filter: broker,
  })
}
