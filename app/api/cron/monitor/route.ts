/**
 * CRON: /api/cron/monitor — every 30 min during market hours
 * SWING MODE: Only exits on emergency stop-loss (-7% same-day) or
 * normal stop-loss (-5%) on OVERNIGHT positions.
 * Never same-day sell unless position is in deep loss.
 *
 * Schedule: every 30 min 14-20 UTC weekdays
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder, getOrders } from '@/lib/schwab'
import { analyzePdtStatus, SWING_CONFIG } from '@/lib/pdt'
import { isMarketOpen, isDailyLossExceeded } from '@/lib/risk'
import { recordLearning } from '@/lib/learning'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db = createServiceClient()
  const start = Date.now()
  const todayStr = today()

  try {
    const [positions, balance, recentOrders] = await Promise.all([
      getPositions(),
      getAccountBalance(),
      getOrders(7),
    ])

    if (positions.length === 0) return NextResponse.json({ status: 'ok', monitored: 0, closed: 0 })

    const activeBalance = balance ?? 2000
    const pdt = analyzePdtStatus(recentOrders, activeBalance)

    // Check daily loss limit — still enforce
    const { data: acctRow } = await db.from('tb_account').select('daily_pnl, id').order('id', { ascending: false }).limit(1).single()
    const dailyPnl = acctRow?.daily_pnl ?? 0
    if (isDailyLossExceeded(dailyPnl, activeBalance)) {
      return NextResponse.json({ status: 'skipped', reason: 'daily_loss_limit' })
    }

    // Fetch open trades metadata (entry date, strategy, peak_pnl)
    const { data: openTrades } = await db
      .from('tb_trades')
      .select('id, symbol, peak_pnl, created_at, strategy, confidence')
      .eq('status', 'OPEN')

    const tradeMap = new Map<string, { id: number; peak: number; entry_date: string; strategy: string; confidence: number }>()
    for (const t of openTrades ?? []) {
      tradeMap.set(t.symbol, {
        id: t.id,
        peak: t.peak_pnl ?? 0,
        entry_date: (t.created_at as string)?.split('T')[0] ?? '',
        strategy: t.strategy ?? '',
        confidence: t.confidence ?? 0,
      })
    }

    let closed = 0
    const statuses: string[] = []

    for (const pos of positions) {
      const meta = tradeMap.get(pos.symbol)
      const storedPeak = meta?.peak ?? 0
      const entryDate  = meta?.entry_date ?? todayStr
      const isSameDay  = entryDate === todayStr

      // Update peak P&L
      const newPeak = Math.max(storedPeak, pos.pnl_pct)
      if (meta?.id && newPeak > storedPeak) {
        await db.from('tb_trades').update({ peak_pnl: newPeak }).eq('id', meta.id)
      }

      let shouldExit  = false
      let exitReason  = ''
      let isDayTrade  = false

      // ── SWING EXIT RULES ─────────────────────────────────────────────────
      if (isSameDay) {
        // Position entered TODAY: only exit if emergency deep loss
        // This avoids wasting PDT slots on minor moves
        if (pos.pnl_pct <= SWING_CONFIG.same_day_emergency_stop) {
          if (pdt.can_day_trade) {
            shouldExit = true
            exitReason = `EMERGENCY STOP ${pos.pnl_pct.toFixed(1)}% (same-day, using PDT slot)`
            isDayTrade = true
          } else {
            // Out of day-trade slots — hold it, accept the loss overnight
            statuses.push(`${pos.symbol}: ${pos.pnl_pct.toFixed(1)}% — deep loss but no PDT slots, holding overnight`)
            continue
          }
        } else {
          statuses.push(`${pos.symbol}: ${pos.pnl_pct.toFixed(1)}% (entered today — swing hold, no exit today)`)
          continue
        }
      } else {
        // OVERNIGHT position — normal stop/trail rules apply
        if (pos.pnl_pct <= SWING_CONFIG.stop_loss_pct) {
          shouldExit = true
          exitReason = `STOP LOSS ${pos.pnl_pct.toFixed(1)}%`
        } else if (newPeak >= SWING_CONFIG.trailing_start_pct && pos.pnl_pct <= newPeak - SWING_CONFIG.trailing_pct) {
          shouldExit = true
          exitReason = `TRAILING STOP (peak ${newPeak.toFixed(1)}% → ${pos.pnl_pct.toFixed(1)}%)`
        } else {
          statuses.push(`${pos.symbol}: ${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}% | peak ${newPeak.toFixed(1)}% | HOLD swing`)
        }
      }

      if (shouldExit) {
        const action = pos.quantity > 0 ? 'SELL' : 'BUY'
        const order = await placeOrder(pos.symbol, Math.abs(pos.quantity), action)

        if (order.status === 'PLACED') {
          closed++
          const pnl = pos.unrealized_pnl
          const holdDays = Math.round((Date.now() - new Date(entryDate + 'T00:00:00Z').getTime()) / 86_400_000)

          if (meta?.id) {
            await db.from('tb_trades').update({
              status: 'CLOSED', exit_price: pos.current_price,
              pnl, pnl_pct: pos.pnl_pct, days_held: holdDays,
              closed_at: new Date().toISOString(),
            }).eq('id', meta.id)
          }

          // Update account daily P&L
          const newDailyPnl = dailyPnl + pnl
          if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: newDailyPnl }).eq('id', acctRow.id)

          // Record learning
          await recordLearning({
            symbol: pos.symbol,
            strategy: meta?.strategy ?? 'SWING',
            pnl_pct: pos.pnl_pct,
            hold_days: holdDays,
            regime: 'NORMAL',
          })

          const alertType = pnl >= 0 ? 'SELL' : 'STOP_LOSS'
          await db.from('tb_alerts').insert({
            type: alertType,
            message: `${isDayTrade ? 'EMERGENCY' : 'SWING'} EXIT ${pos.symbol}: ${exitReason} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pos.pnl_pct.toFixed(1)}%) | Held ${holdDays}d`,
            symbol: pos.symbol, pnl,
          })

          statuses.push(`${pos.symbol}: CLOSED ${exitReason} | $${pnl.toFixed(2)}`)
        }
      }
    }

    // Hourly P&L snapshot
    const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10)
    await db.from('tb_pnl_snapshots').upsert({
      date: todayStr, hour: etHour, balance: activeBalance, daily_pnl: dailyPnl + positions.reduce((s, p) => s + p.unrealized_pnl, 0),
    }, { onConflict: 'date,hour' })

    await db.from('tb_cron_log').insert({
      job: 'monitor', status: 'success', trades_made: closed,
      message: `PDT:${pdt.day_trades_used}/3 | ${statuses.join(' | ')}`,
      duration_ms: Date.now() - start,
    })

    return NextResponse.json({ status: 'ok', monitored: positions.length, closed, pdt_used: pdt.day_trades_used, statuses })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'monitor', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
