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

  // Strict per-broker queries — Schwab and Alpaca NEVER share data.
  // Rows without a broker column (created before broker field existed) go to alpaca_paper.
  const todayISO = new Date().toISOString().split('T')[0] + 'T00:00:00Z'
  const t = db.from('tb_trades').select('*').gte('created_at', todayISO).order('created_at', { ascending: false }).limit(60)
  const a = db.from('tb_alerts').select('*').order('created_at', { ascending: false }).limit(15)
  const p = db.from('tb_pnl_snapshots').select('*').eq('date', new Date().toISOString().split('T')[0]).order('hour')

  const tradesStrict = broker === 'schwab'
    ? db.from('tb_trades').select('*').eq('broker', 'schwab').gte('created_at', todayISO).order('created_at', { ascending: false }).limit(60)
    : broker === 'alpaca_paper'
      ? db.from('tb_trades').select('*').or('broker.eq.alpaca_paper,broker.is.null').gte('created_at', todayISO).order('created_at', { ascending: false }).limit(60)
      : t

  const alertsStrict = broker === 'schwab'
    ? db.from('tb_alerts').select('*').eq('broker', 'schwab').order('created_at', { ascending: false }).limit(15)
    : broker === 'alpaca_paper'
      ? db.from('tb_alerts').select('*').or('broker.eq.alpaca_paper,broker.is.null').order('created_at', { ascending: false }).limit(15)
      : a

  const pnlStrict = broker !== 'all' ? p.eq('broker', broker) : p

  const [
    accountResult, tradesResult, alertsResult,
    dailySummaryResult, cronResult, pnlResult, engineResult,
  ] = await Promise.all([
    db.from('tb_account').select('*').order('id', { ascending: false }).limit(1).single(),
    tradesStrict,
    alertsStrict,
    db.from('tb_daily_summary').select('*').order('date', { ascending: false }).limit(7),
    db.from('tb_cron_log').select('*').order('created_at', { ascending: false }).limit(8),
    pnlStrict,
    db.from('tb_context').select('key, value').in('key', ['engine_schwab', 'engine_alpaca']),
  ])

  const trades = tradesResult.data ?? []
  const alerts = alertsResult.data ?? []

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
