import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { getPositions as AlpacaPositions } from '@/lib/alpaca'
import { getPositions as SchwabPositions } from '@/lib/schwab'

function isTgTrade(reason: string | null): boolean {
  const r = (reason ?? '').toLowerCase()
  return r.includes('tg:') || r.includes('sf essential') || r.includes('sf_essential')
}

export async function GET() {
  const db = createServiceClient()

  // Fetch live positions from both brokers + tb_trades source info in parallel
  const [alpacaPos, schwabPos, { data: openTrades }] = await Promise.all([
    AlpacaPositions().catch(() => []),
    SchwabPositions().catch(() => []),
    db.from('tb_trades').select('symbol, broker, reason, confidence, stop_loss, target_price').eq('status', 'OPEN'),
  ])

  // Build source lookup: symbol+broker → sf_trades | ai_scan
  const sourceMap = new Map<string, 'sf_trades' | 'ai_scan'>()
  for (const t of openTrades ?? []) {
    sourceMap.set(`${t.symbol}:${t.broker}`, isTgTrade(t.reason) ? 'sf_trades' : 'ai_scan')
  }
  const metaMap = new Map<string, { confidence: number; stop_loss: number | null; target_price: number | null }>()
  for (const t of openTrades ?? []) {
    metaMap.set(`${t.symbol}:${t.broker}`, { confidence: t.confidence, stop_loss: t.stop_loss, target_price: t.target_price })
  }

  const positions = [
    ...alpacaPos.map(p => ({ ...p, broker: 'alpaca_paper' as const })),
    ...schwabPos.map(p => ({ ...p, broker: 'schwab' as const })),
  ].map(p => ({
    symbol:       p.symbol,
    broker:       p.broker,
    qty:          p.quantity,
    pl_day:       0,
    pl_open:      p.unrealized_pnl ?? 0,
    pl_pct:       p.pnl_pct ?? 0,
    avg_cost:     (p.avg_cost ?? p.current_price) * p.quantity,
    net_liq:      p.market_value ?? (p.current_price * p.quantity),
    mark:         p.current_price,
    source:       sourceMap.get(`${p.symbol}:${p.broker}`) ?? 'ai_scan',
    confidence:   metaMap.get(`${p.symbol}:${p.broker}`)?.confidence ?? 0,
    stop_loss:    metaMap.get(`${p.symbol}:${p.broker}`)?.stop_loss ?? null,
    target_price: metaMap.get(`${p.symbol}:${p.broker}`)?.target_price ?? null,
  }))

  // Closed trades from tb_trades (last 30 days) for history section
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: closedTrades } = await db
    .from('tb_trades')
    .select('id, symbol, broker, quantity, entry_price, exit_price, pnl, pnl_pct, confidence, reason, created_at, closed_at')
    .eq('status', 'CLOSED')
    .gte('closed_at', thirtyDaysAgo)
    .order('closed_at', { ascending: false })
    .limit(100)

  const history = (closedTrades ?? []).map(t => ({ ...t, source: isTgTrade(t.reason) ? 'sf_trades' : 'ai_scan' }))

  return NextResponse.json({ positions, history }, { headers: { 'Cache-Control': 'no-store' } })
}
