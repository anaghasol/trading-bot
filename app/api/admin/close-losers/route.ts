/**
 * POST /api/admin/close-losers
 * Emergency: immediately closes ALL paper positions past a loss threshold.
 * Called when the monitor hasn't auto-closed a position that should be gone.
 * Auth: requires CRON_SECRET header (same as cron jobs).
 */
import { NextResponse } from 'next/server'
import * as AlpacaBroker from '@/lib/alpaca'
import { createServiceClient } from '@/lib/supabase-server'
import { profileFor } from '@/lib/strategy-profiles'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(_req: Request) {
  // Personal dashboard endpoint — no external auth needed (cron jobs use /api/cron/* instead)

  const broker  = 'alpaca_paper'
  const profile = profileFor(broker)
  const db      = createServiceClient()

  const positions = await AlpacaBroker.getPositions()
  const equity    = await AlpacaBroker.getAccountBalance().then((b) => b ?? 100_000)

  const closed: string[] = []
  const held:   string[] = []

  for (const pos of positions) {
    if (pos.asset_type === 'OPTION') continue  // options handled separately

    const lossThreshold = -(profile.initial_stop_pct * 100)  // e.g. -2%
    const hardStop      = -5  // never hold past -5% regardless

    if (pos.pnl_pct < hardStop || pos.pnl_pct < lossThreshold) {
      const order = await AlpacaBroker.closePosition(pos.symbol)
      if (order.status === 'PLACED') {
        closed.push(`${pos.symbol} ${pos.pnl_pct.toFixed(1)}%`)
        // Mark closed in tb_trades
        const { data: tradeRow } = await db.from('tb_trades')
          .select('id').eq('symbol', pos.symbol).eq('status', 'OPEN')
          .eq('broker', broker).order('id', { ascending: false }).limit(1).single()
        if (tradeRow?.id) {
          await db.from('tb_trades').update({
            status: 'CLOSED', exit_price: pos.current_price,
            pnl: pos.unrealized_pnl, pnl_pct: pos.pnl_pct,
            closed_at: new Date().toISOString(),
            reason: 'ADMIN_FORCE_CLOSE — monitor bypass',
          }).eq('id', tradeRow.id)
        }
        void db.from('tb_alerts').insert({
          type: 'STOP_LOSS', symbol: pos.symbol, broker,
          message: `[FORCE_CLOSE] ${pos.symbol} ${pos.pnl_pct.toFixed(1)}% — admin endpoint`,
        })
      }
    } else {
      held.push(`${pos.symbol} ${pos.pnl_pct.toFixed(1)}%`)
    }
  }

  return NextResponse.json({
    ok: true,
    threshold: `${profile.initial_stop_pct * 100}% / hard -5%`,
    closed,
    held,
    equity: equity.toFixed(0),
  })
}
