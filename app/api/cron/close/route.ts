/**
 * CRON: /api/cron/close — SWING EXIT checker
 * Runs at 9:35 AM ET (morning review) and 3:30 PM ET (pre-close review).
 *
 * Morning (9:35 AM): exit positions that hit profit target overnight.
 * Pre-close (3:30 PM): exit positions held 5+ days (time stop).
 * Does NOT force-close everything (we're swing trading).
 *
 * Schedule: "35 14 * * 1-5" (9:35 AM ET = 14:35 UTC) + "30 20 * * 1-5" (3:30 PM ET)
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder, getOrders } from '@/lib/broker'
import { analyzePdtStatus, SWING_CONFIG } from '@/lib/pdt'
import { recordLearning } from '@/lib/learning'
import { alertEODSummary } from '@/lib/notify'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function etHour(): number {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const hour = etHour()
  const today = new Date().toISOString().split('T')[0]

  // Run at 9:35 AM (morning review) or 3:30 PM (pre-close time-stop)
  const isMorning  = hour === 9
  const isPreClose = hour === 15

  if (!isMorning && !isPreClose) {
    return NextResponse.json({ status: 'skipped', reason: `not_exit_window (hour ${hour} ET)` })
  }

  try {
    const [positions, balance, recentOrders] = await Promise.all([
      getPositions(),
      getAccountBalance(),
      getOrders(10),
    ])

    const activeBalance = balance ?? 2000
    const pdt = analyzePdtStatus(recentOrders, activeBalance)

    // Load open trade metadata
    const { data: openTrades } = await db
      .from('tb_trades')
      .select('id, symbol, peak_pnl, created_at, strategy, confidence, entry_price')
      .eq('status', 'OPEN')

    const tradeMap = new Map<string, { id: number; entry_date: string; strategy: string; entry_price: number }>()
    for (const t of openTrades ?? []) {
      tradeMap.set(t.symbol, {
        id: t.id,
        entry_date: (t.created_at as string)?.split('T')[0] ?? today,
        strategy: t.strategy ?? '',
        entry_price: t.entry_price ?? 0,
      })
    }

    let closed = 0
    const actions: string[] = []

    const { data: acctRow } = await db.from('tb_account').select('daily_pnl, total_pnl, id').order('id', { ascending: false }).limit(1).single()
    let dailyPnl = acctRow?.daily_pnl ?? 0

    for (const pos of positions) {
      const meta = tradeMap.get(pos.symbol)
      if (!meta) continue

      const entryDate = meta.entry_date
      const holdDays  = Math.round((Date.now() - new Date(entryDate + 'T00:00:00Z').getTime()) / 86_400_000)
      const isSameDay = entryDate === today

      let shouldExit  = false
      let exitReason  = ''

      if (isMorning) {
        // Morning: exit only if held max days AND losing — winners keep riding
        if (!isSameDay && holdDays >= SWING_CONFIG.max_hold_days && pos.pnl_pct < 0) {
          shouldExit = true
          exitReason = `TIME STOP (losing ${pos.pnl_pct.toFixed(1)}% after ${holdDays}d)`
        }
      }

      if (isPreClose) {
        // Pre-close: cut losers held 3+ days. Winners ride — trailing stop catches them.
        if (!isSameDay && holdDays >= 3 && pos.pnl_pct < -2) {
          shouldExit = true
          exitReason = `PRE-CLOSE CUT: ${pos.pnl_pct.toFixed(1)}% after ${holdDays}d`
        }
        // Also close if hit big profit target (lock in outlier wins at pre-close)
        if (!isSameDay && pos.pnl_pct >= 20) {
          shouldExit = true
          exitReason = `BIG WIN LOCK: +${pos.pnl_pct.toFixed(1)}% — banking it`
        }
      }

      if (!shouldExit) {
        actions.push(`${pos.symbol}: ${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}% hold (${holdDays}d/${SWING_CONFIG.max_hold_days}d max)`)
        continue
      }

      const action = pos.quantity > 0 ? 'SELL' : 'BUY'
      const order = await placeOrder(pos.symbol, Math.abs(pos.quantity), action)

      if (order.status === 'PLACED') {
        closed++
        const pnl = pos.unrealized_pnl
        dailyPnl += pnl

        if (meta.id) {
          await db.from('tb_trades').update({
            status: 'CLOSED', exit_price: pos.current_price,
            pnl, pnl_pct: pos.pnl_pct, days_held: holdDays,
            closed_at: new Date().toISOString(),
          }).eq('id', meta.id)
        }

        if (acctRow?.id) {
          await db.from('tb_account').update({
            daily_pnl: dailyPnl,
            total_pnl: (acctRow.total_pnl ?? 0) + pnl,
          }).eq('id', acctRow.id)
        }

        await recordLearning({
          symbol: pos.symbol, strategy: meta.strategy,
          pnl_pct: pos.pnl_pct, hold_days: holdDays, regime: 'NORMAL',
        })

        await db.from('tb_alerts').insert({
          type: pnl >= 0 ? 'SELL' : 'STOP_LOSS',
          message: `SWING EXIT ${pos.symbol}: ${exitReason} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pos.pnl_pct.toFixed(1)}%)`,
          symbol: pos.symbol, pnl,
        })

        actions.push(`${pos.symbol}: CLOSED ${exitReason} | $${pnl.toFixed(2)}`)
      }
    }

    // Write daily summary if pre-close
    if (isPreClose) {
      const { data: todayTrades } = await db
        .from('tb_trades').select('pnl, symbol')
        .gte('closed_at', `${today}T00:00:00Z`).eq('status', 'CLOSED')

      const wins   = todayTrades?.filter((t) => t.pnl > 0).length ?? 0
      const losses = todayTrades?.filter((t) => t.pnl < 0).length ?? 0

      await db.from('tb_daily_summary').upsert({
        date: today,
        starting_balance: activeBalance - dailyPnl,
        ending_balance: activeBalance,
        daily_pnl: dailyPnl,
        total_pnl: (acctRow?.total_pnl ?? 0) + dailyPnl,
        wins, losses,
        win_rate: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'date' })

      // SMS EOD summary to owner phone
      await alertEODSummary({
        daily_pnl: dailyPnl,
        balance: activeBalance,
        wins, losses,
        trades: wins + losses,
      })
    }

    await db.from('tb_cron_log').insert({
      job: 'close', status: 'success', trades_made: closed,
      message: `${isMorning ? 'Morning' : 'Pre-close'} swing review | PDT:${pdt.day_trades_used}/3 | Closed:${closed} | ${actions.join(' | ')}`,
    })

    return NextResponse.json({
      status: 'ok', window: isMorning ? 'morning' : 'pre_close',
      closed, pdt_used: pdt.day_trades_used,
      positions_checked: positions.length, actions,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'close', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
