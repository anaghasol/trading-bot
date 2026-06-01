/**
 * CRON: /api/cron/monitor
 * Elite risk engine: 2.5% initial stop, 5% trailing from peak, partial exit at 2:1.
 * Runs every 15 min during market hours.
 * No same-day sells on PDT-restricted accounts (holds overnight) unless emergency.
 */
import { NextResponse } from 'next/server'
import { getPositions, getAccountBalance, placeOrder, getOrders } from '@/lib/schwab'
import { checkExitCondition, shouldTakePartial, isMarketOpen, isDailyLossExceeded, INITIAL_STOP_PCT, TRAIL_PCT } from '@/lib/risk'
import { analyzePdtStatus } from '@/lib/pdt'
import { recordLearning } from '@/lib/learning'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function today() { return new Date().toISOString().split('T')[0] }

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db      = createServiceClient()
  const start   = Date.now()
  const todayStr = today()

  try {
    const [positions, balance, recentOrders] = await Promise.all([
      getPositions(),
      getAccountBalance(),
      getOrders(7),
    ])

    if (positions.length === 0) {
      return NextResponse.json({ status: 'ok', monitored: 0, closed: 0, partial: 0 })
    }

    const activeBalance = balance ?? 2000
    const pdt = analyzePdtStatus(recentOrders, activeBalance)

    const { data: acctRow } = await db.from('tb_account').select('daily_pnl, id').order('id', { ascending: false }).limit(1).single()
    const dailyPnl = acctRow?.daily_pnl ?? 0

    if (isDailyLossExceeded(dailyPnl, activeBalance)) {
      await db.from('tb_alerts').insert({ type: 'INFO', message: `Daily loss limit reached ($${dailyPnl.toFixed(2)}). No more exits until tomorrow.` })
      return NextResponse.json({ status: 'skipped', reason: 'daily_loss_limit' })
    }

    // Load trade journal entries
    const { data: openTrades } = await db
      .from('tb_trades')
      .select('id, symbol, entry_price, peak_pnl, created_at, strategy, confidence, reason')
      .eq('status', 'OPEN')

    const tradeMap = new Map<string, {
      id: number
      entry_price: number
      peak_price: number
      initial_stop_price: number
      partial_exit_done: boolean
      partial_exit_qty: number
      entry_date: string
      strategy: string
    }>()

    for (const t of openTrades ?? []) {
      const ep = t.entry_price ?? 0
      // Parse risk params from reason field if v3 migration not yet run
      const reasonStr = (t.reason as string) ?? ''
      const stopMatch  = reasonStr.match(/stop=\$([0-9.]+)/)
      const peakPnlPct = (t.peak_pnl as number) ?? 0
      const derivedPeak = ep > 0 ? ep * (1 + peakPnlPct / 100) : ep

      tradeMap.set(t.symbol, {
        id:                 t.id,
        entry_price:        ep,
        peak_price:         derivedPeak,
        initial_stop_price: stopMatch ? parseFloat(stopMatch[1]) : ep * (1 - INITIAL_STOP_PCT),
        partial_exit_done:  false,
        partial_exit_qty:   0,
        entry_date:         (t.created_at as string)?.split('T')[0] ?? todayStr,
        strategy:           t.strategy ?? 'SWING',
      })
    }

    let fullExits    = 0
    let partialExits = 0
    let runningDailyPnl = dailyPnl
    const statuses: string[] = []

    for (const pos of positions) {
      const meta = tradeMap.get(pos.symbol)
      if (!meta || !meta.entry_price) {
        statuses.push(`${pos.symbol}: no journal entry`)
        continue
      }

      const isSameDay = meta.entry_date === todayStr
      const holdDays  = Math.round(
        (Date.now() - new Date(meta.entry_date + 'T00:00:00Z').getTime()) / 86_400_000
      )

      const target_price = meta.entry_price * (1 + INITIAL_STOP_PCT * 2)  // 2:1 = 5%

      // ── Check partial exit first ──────────────────────────────────────────
      if (shouldTakePartial(pos.current_price, meta.entry_price, target_price, meta.partial_exit_done)) {
        // Sell 50% of position
        const partialQty = Math.max(1, Math.floor(Math.abs(pos.quantity) * 0.5))

        if (!isSameDay || pdt.can_day_trade) {
          const order = await placeOrder(pos.symbol, partialQty, pos.quantity > 0 ? 'SELL' : 'BUY')

          if (order.status === 'PLACED') {
            partialExits++
            const partialPnl = (pos.current_price - meta.entry_price) * partialQty
            runningDailyPnl += partialPnl

            await db.from('tb_trades').update({
              partial_exit_done: true,
              partial_exit_qty: partialQty,
              peak_price: Math.max(meta.peak_price, pos.current_price),
            }).eq('id', meta.id)

            if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningDailyPnl }).eq('id', acctRow.id)

            await db.from('tb_alerts').insert({
              type: 'SELL',
              message: `PARTIAL EXIT ${partialQty}/${pos.quantity} ${pos.symbol} @ $${pos.current_price.toFixed(2)} +${(((pos.current_price - meta.entry_price) / meta.entry_price) * 100).toFixed(1)}% — 2:1 target hit. Trailing remaining ${pos.quantity - partialQty} shares.`,
              symbol: pos.symbol,
              pnl: partialPnl,
            })

            statuses.push(`${pos.symbol}: PARTIAL SOLD ${partialQty} @ 2:1 target +${(((pos.current_price - meta.entry_price) / meta.entry_price) * 100).toFixed(1)}%`)
            continue
          }
        } else {
          statuses.push(`${pos.symbol}: at 2:1 target but PDT slots exhausted — holding swing`)
          continue
        }
      }

      // ── Check full exit (stop / trail / time) ─────────────────────────────
      const exit = checkExitCondition(
        pos.current_price,
        meta.entry_price,
        meta.peak_price,
        meta.initial_stop_price,
        holdDays,
        meta.partial_exit_done
      )

      // Update peak in journal (use peak_pnl for backwards compatibility)
      if (exit.new_peak_price > meta.peak_price && meta.id && meta.entry_price > 0) {
        const newPeakPnlPct = ((exit.new_peak_price - meta.entry_price) / meta.entry_price) * 100
        await db.from('tb_trades').update({ peak_pnl: newPeakPnlPct }).eq('id', meta.id)
      }

      if (!exit.should_exit) {
        statuses.push(`${pos.symbol}: ${exit.reason}`)
        continue
      }

      // PDT check: if entered today and NOT an emergency, hold overnight
      const isEmergency = exit.exit_type === 'INITIAL_STOP' && exit.pnl_pct < -6
      if (isSameDay && !pdt.can_day_trade && !isEmergency) {
        statuses.push(`${pos.symbol}: ${exit.exit_type} triggered but PDT exhausted — holding overnight (${exit.pnl_pct.toFixed(1)}%)`)
        continue
      }

      // Execute exit
      const action = pos.quantity > 0 ? 'SELL' : 'BUY'
      const order = await placeOrder(pos.symbol, Math.abs(pos.quantity), action)

      if (order.status === 'PLACED') {
        fullExits++
        const pnl = pos.unrealized_pnl
        runningDailyPnl += pnl

        if (meta.id) {
          await db.from('tb_trades').update({
            status: 'CLOSED',
            exit_price: pos.current_price,
            pnl,
            pnl_pct: exit.pnl_pct,
            days_held: holdDays,
            closed_at: new Date().toISOString(),
          }).eq('id', meta.id)
        }

        if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningDailyPnl }).eq('id', acctRow.id)

        await recordLearning({
          symbol: pos.symbol, strategy: meta.strategy,
          pnl_pct: exit.pnl_pct, hold_days: holdDays, regime: 'NORMAL',
        })

        const alertType = pnl >= 0 ? 'SELL' : 'STOP_LOSS'
        await db.from('tb_alerts').insert({
          type: alertType,
          message: `${exit.exit_type}: ${pos.symbol} @ $${pos.current_price.toFixed(2)} | ${exit.reason} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Held ${holdDays}d`,
          symbol: pos.symbol, pnl,
        })

        statuses.push(`${pos.symbol}: CLOSED ${exit.exit_type} | $${pnl.toFixed(2)}`)
      }
    }

    // Update P&L snapshot
    const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10)
    const unrealizedTotal = positions.reduce((s, p) => s + p.unrealized_pnl, 0)
    await db.from('tb_pnl_snapshots').upsert({
      date: todayStr, hour: etHour,
      balance: activeBalance,
      daily_pnl: runningDailyPnl + unrealizedTotal,
    }, { onConflict: 'date,hour' })

    await db.from('tb_cron_log').insert({
      job: 'monitor', status: 'success',
      trades_made: fullExits + partialExits,
      message: `PDT:${pdt.day_trades_used}/3 | Full exits:${fullExits} Partial:${partialExits} | ${statuses.join(' | ')}`,
      duration_ms: Date.now() - start,
    })

    return NextResponse.json({
      status: 'ok',
      monitored: positions.length, full_exits: fullExits, partial_exits: partialExits,
      pdt_used: pdt.day_trades_used, pdt_remaining: pdt.day_trades_remaining,
      daily_pnl: runningDailyPnl, statuses,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'monitor', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
