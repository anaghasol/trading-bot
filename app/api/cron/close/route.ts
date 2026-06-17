/**
 * CRON: /api/cron/close — SWING EXIT checker (dual-broker)
 * Runs at 9:35 AM ET (morning review) and 3:30 PM ET (pre-close review).
 *
 * Morning (9:35 AM): flat recycler, time-stop losers, morning brief SMS.
 * Pre-close (3:30 PM): cut aging losers, lock big wins, EOD comparison SMS.
 *
 * Schedule: "35 14 * * 1-5" (9:35 AM ET = 14:35 UTC) + "30 20 * * 1-5" (3:30 PM ET)
 */
import { NextResponse } from 'next/server'
import * as SchwabBroker from '@/lib/schwab'
import * as AlpacaBroker from '@/lib/alpaca'
import { analyzePdtStatus } from '@/lib/pdt'
import { profileFor } from '@/lib/strategy-profiles'
import { recordLearning } from '@/lib/learning'
import { alertEODComparison, alertMorningBrief } from '@/lib/notify'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function etHour(): number {
  return parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10,
  )
}

async function runClose(
  broker: 'schwab' | 'alpaca_paper',
  db: ReturnType<typeof createServiceClient>,
  isMorning: boolean,
  isPreClose: boolean,
): Promise<{ closed: number; pdt_used: number; balance: number; actions: string[] }> {
  const isSchwab = broker === 'schwab'
  const api      = isSchwab ? SchwabBroker : AlpacaBroker
  const profile  = profileFor(broker)
  const today    = new Date().toISOString().split('T')[0]

  const [positions, balance, recentOrders] = await Promise.all([
    api.getPositions(),
    api.getAccountBalance(),
    api.getOrders(10),
  ])

  const activeBalance = balance ?? (isSchwab ? 2000 : 100_000)
  const pdtUsed = isSchwab ? analyzePdtStatus(recentOrders, activeBalance).day_trades_used : 0

  // Only load open trades belonging to this broker
  const brokerFilter = isSchwab ? 'broker.eq.schwab,broker.is.null' : 'broker.eq.alpaca_paper'
  const { data: openTrades } = await db
    .from('tb_trades')
    .select('id, symbol, created_at, strategy, entry_price, reason')
    .eq('status', 'OPEN')
    .or(brokerFilter)

  const tradeMap = new Map<string, { id: number; entry_date: string; strategy: string; entry_price: number; hold_mode: 'day' | 'swing' | 'trend' }>()
  for (const t of openTrades ?? []) {
    const holdModeMatch = (t.reason as string | null)?.match(/hold_mode=(\w+)/)
    tradeMap.set(t.symbol, {
      id: t.id,
      entry_date: (t.created_at as string)?.split('T')[0] ?? today,
      strategy: t.strategy ?? '',
      entry_price: t.entry_price ?? 0,
      hold_mode: (holdModeMatch?.[1] ?? 'swing') as 'day' | 'swing' | 'trend',
    })
  }

  let closed = 0
  const actions: string[] = []

  for (const pos of positions) {
    const meta = tradeMap.get(pos.symbol)
    if (!meta) continue

    const holdDays  = Math.round((Date.now() - new Date(meta.entry_date + 'T00:00:00Z').getTime()) / 86_400_000)
    const isSameDay = meta.entry_date === today
    const isTrend   = meta.hold_mode === 'trend'
    const isDay     = meta.hold_mode === 'day'

    let shouldExit = false
    let exitReason = ''

    if (isMorning) {
      // Time stop: held max days AND still a loser
      // SKIP for trend positions — they're designed to hold past the calendar limit
      if (!isTrend && !isSameDay && holdDays >= profile.max_hold_days && pos.pnl_pct < 0) {
        shouldExit = true
        exitReason = `TIME STOP (losing ${pos.pnl_pct.toFixed(1)}% after ${holdDays}d)`
      }
      // Day positions: must exit next morning if not already closed EOD
      if (isDay && !isSameDay) {
        shouldExit = true
        exitReason = `DAY EXIT (overnight hold not intended)`
      }
      // Flat recycler: stuck between -2% and +2.5% for 2+ days — dead capital
      // SKIP for trend positions — they may be basing before next leg up
      if (!shouldExit && !isTrend && !isSameDay && holdDays >= 2 && pos.pnl_pct > -2 && pos.pnl_pct < 2.5) {
        shouldExit = true
        exitReason = `FLAT RECYCLE (${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}% after ${holdDays}d — redeploying capital)`
      }
    }

    if (isPreClose) {
      // Cut losers held 3+ days — these aren't recovering.
      // Trend positions get a wider loss bar (-5%) before we cut them — they need more room.
      const lossBar = isTrend ? -5 : -2
      if (!isSameDay && holdDays >= 3 && pos.pnl_pct < lossBar) {
        shouldExit = true
        exitReason = `PRE-CLOSE CUT: ${pos.pnl_pct.toFixed(1)}% after ${holdDays}d${isTrend ? ' [trend -5% bar]' : ''}`
      }
      // Winners of any size: let trailing stop manage the exit.
      // No arbitrary cap — a +22% position with a tight trail could go to +40%.
    }

    if (!shouldExit) {
      const modeLabel = isTrend ? ' [TREND — no time limit]' : isDay ? ' [DAY]' : ''
      actions.push(`${pos.symbol}: ${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}% hold (${holdDays}d${isTrend ? '' : `/${profile.max_hold_days}d max`})${modeLabel}`)
      continue
    }

    const action = pos.quantity > 0 ? 'SELL' : 'BUY'
    const order  = await api.placeOrder(pos.symbol, Math.abs(pos.quantity), action)

    if (order.status === 'PLACED') {
      closed++
      const pnl = pos.unrealized_pnl

      if (meta.id) {
        await db.from('tb_trades').update({
          status: 'CLOSED', exit_price: pos.current_price,
          pnl, pnl_pct: pos.pnl_pct, days_held: holdDays,
          closed_at: new Date().toISOString(),
        }).eq('id', meta.id)
      }

      await recordLearning({
        symbol:     pos.symbol,
        strategy:   meta.strategy,
        pnl_pct:    pos.pnl_pct,
        hold_days:  holdDays,
        regime:     'NORMAL',
        exit_type:  exitReason,
        exit_price: pos.current_price,
        entry_price: meta.entry_price,
        hold_mode:  meta.hold_mode,
        broker,
      })

      await db.from('tb_alerts').insert({
        type: pnl >= 0 ? 'SELL' : 'STOP_LOSS',
        message: `[${broker}] SWING EXIT ${pos.symbol}: ${exitReason} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pos.pnl_pct.toFixed(1)}%)`,
        symbol: pos.symbol, pnl,
      })

      actions.push(`${pos.symbol}: CLOSED ${exitReason} | $${pnl.toFixed(2)}`)
    }
  }

  // Morning brief SMS for this broker
  if (isMorning) {
    const recycled   = actions.filter((a) => a.includes('FLAT RECYCLE')).map((a) => a.split(':')[0].trim())
    const stillOpen  = positions.filter((p) => !recycled.includes(p.symbol))

    await alertMorningBrief({
      account_value: activeBalance,
      open_pnl: stillOpen.reduce((s, p) => s + p.unrealized_pnl, 0),
      positions: stillOpen.map((p) => ({
        symbol:    p.symbol,
        pnl_pct:  p.pnl_pct,
        hold_days: Math.round(
          (Date.now() - new Date((tradeMap.get(p.symbol)?.entry_date ?? today) + 'T00:00:00Z').getTime()) / 86_400_000,
        ),
      })),
      recycled,
      regime: isSchwab ? 'LIVE' : 'PAPER',
    }).catch(() => {})
  }

  return { closed, pdt_used: pdtUsed, balance: activeBalance, actions }
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db    = createServiceClient()
  const hour  = etHour()
  const today = new Date().toISOString().split('T')[0]

  const isMorning  = hour === 9
  const isPreClose = hour === 15

  if (!isMorning && !isPreClose) {
    return NextResponse.json({ status: 'skipped', reason: `not_exit_window (hour ${hour} ET)` })
  }

  try {
    const [schwabResult, paperResult] = await Promise.allSettled([
      runClose('schwab',       db, isMorning, isPreClose),
      runClose('alpaca_paper', db, isMorning, isPreClose),
    ])

    const schwab = schwabResult.status === 'fulfilled' ? schwabResult.value : { closed: 0, pdt_used: 0, balance: 2000,   actions: [`schwab error: ${(schwabResult as PromiseRejectedResult).reason}`] }
    const paper  = paperResult.status  === 'fulfilled' ? paperResult.value  : { closed: 0, pdt_used: 0, balance: 100_000, actions: [`paper error: ${(paperResult  as PromiseRejectedResult).reason}`] }

    // EOD comparison SMS — once at pre-close after both brokers processed
    if (isPreClose) {
      const { data: paperClosed } = await db.from('tb_trades').select('pnl').gte('closed_at', `${today}T00:00:00Z`).eq('status', 'CLOSED').eq('broker', 'alpaca_paper')
      const { data: liveClosed  } = await db.from('tb_trades').select('pnl').gte('closed_at', `${today}T00:00:00Z`).eq('status', 'CLOSED').eq('broker', 'schwab')
      const paperPnl   = (paperClosed ?? []).reduce((s, t) => s + (t.pnl ?? 0), 0)
      const livePnl    = (liveClosed  ?? []).reduce((s, t) => s + (t.pnl ?? 0), 0)
      const paperWins  = (paperClosed ?? []).filter((t) => t.pnl > 0).length
      const paperLoss  = (paperClosed ?? []).filter((t) => t.pnl < 0).length
      const liveWins   = (liveClosed  ?? []).filter((t) => t.pnl > 0).length
      const liveLoss   = (liveClosed  ?? []).filter((t) => t.pnl < 0).length

      await alertEODComparison({
        paper_pnl: paperPnl, paper_balance: paper.balance,
        live_pnl: livePnl,   live_balance: schwab.balance,
        paper_wins: paperWins, paper_losses: paperLoss,
        live_wins: liveWins,   live_losses: liveLoss,
      }).catch(() => {})
    }

    const totalClosed = schwab.closed + paper.closed
    const summary = [
      `schwab: ${schwab.closed} closed, PDT ${schwab.pdt_used}/3`,
      `paper:  ${paper.closed} closed`,
      ...(schwab.actions.length ? schwab.actions : []),
      ...(paper.actions.length ? paper.actions : []),
    ].join(' | ')

    await db.from('tb_cron_log').insert({
      job: 'close', status: 'success', trades_made: totalClosed,
      message: `${isMorning ? 'Morning' : 'Pre-close'} swing review | ${summary}`,
    })

    return NextResponse.json({
      status: 'ok',
      window: isMorning ? 'morning' : 'pre_close',
      schwab: { closed: schwab.closed, pdt_used: schwab.pdt_used, balance: schwab.balance },
      paper:  { closed: paper.closed,  balance: paper.balance },
      actions: { schwab: schwab.actions, paper: paper.actions },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({ job: 'close', status: 'error', message: msg })
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
