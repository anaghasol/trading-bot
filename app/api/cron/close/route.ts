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

  const tradeMap = new Map<string, { id: number; entry_date: string; strategy: string; entry_price: number; hold_mode: 'day' | 'swing' | 'trend'; isTgTrade: boolean }>()
  for (const t of openTrades ?? []) {
    const holdModeMatch = (t.reason as string | null)?.match(/hold_mode=(\w+)/)
    const isTgTrade = (t.reason as string | null)?.includes('tg_trade=1') ?? false
    tradeMap.set(t.symbol, {
      id: t.id,
      entry_date: (t.created_at as string)?.split('T')[0] ?? today,
      strategy: t.strategy ?? '',
      entry_price: t.entry_price ?? 0,
      hold_mode: (holdModeMatch?.[1] ?? 'swing') as 'day' | 'swing' | 'trend',
      isTgTrade,
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

    // TG trades (Pavan SF, US Equities, Jimmy): never force-close via our rules.
    // They're managed by the channel's own exit signals, not time stops or pre-close cuts.
    if (meta.isTgTrade) {
      actions.push(`${pos.symbol}: TG trade — no forced exit (awaiting channel exit signal)`)
      continue
    }

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
      // Flat recycler: stuck between -2% and +2.5% for 3+ days — dead capital
      // SKIP for trend positions — they may be basing before next leg up
      if (!shouldExit && !isTrend && !isSameDay && holdDays >= 3 && pos.pnl_pct > -2 && pos.pnl_pct < 2.5) {
        shouldExit = true
        exitReason = `FLAT RECYCLE (${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}% after ${holdDays}d — redeploying capital)`
      }
    }

    if (isPreClose) {
      // Cut losers held 3+ days — these aren't recovering.
      // Trend positions: graduated loss bar so SNDK runners get room to consolidate.
      //   - Days 3-6 (new trend): -5% — catch bad entries quickly
      //   - Days 7+  (established): -8% — allow normal pullback before next leg
      // Swing positions: -2% after 3 days (tight, fast recycling)
      const lossBar = isTrend
        ? (holdDays >= 7 ? -8 : -5)
        : -2
      if (!isSameDay && holdDays >= 3 && pos.pnl_pct < lossBar) {
        shouldExit = true
        exitReason = `PRE-CLOSE CUT: ${pos.pnl_pct.toFixed(1)}% after ${holdDays}d${isTrend ? ` [trend ${lossBar}% bar, ${holdDays}d]` : ''}`
      }
      // Winners of any size: let trailing stop manage the exit.
      // No arbitrary cap — a +22% position with a tight trail could go to +40%.
    }

    if (!shouldExit) {
      const modeLabel = isTrend ? ' [TREND — no time limit]' : isDay ? ' [DAY]' : ''
      if (isTrend) {
        console.log(`[${broker}][close] Skipped trend position ${pos.symbol} (hold_mode=trend, pnl=${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}%, days=${holdDays})`)
      }
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

    // EOD report — once at pre-close after both brokers processed
    if (isPreClose) {
      const [paperClosedRes, liveClosedRes] = await Promise.all([
        db.from('tb_trades').select('pnl,symbol,strategy,reason').gte('closed_at', `${today}T00:00:00Z`).eq('status', 'CLOSED').or('broker.eq.alpaca_paper,broker.is.null'),
        db.from('tb_trades').select('pnl,symbol,strategy,reason').gte('closed_at', `${today}T00:00:00Z`).eq('status', 'CLOSED').eq('broker', 'schwab'),
      ])
      const pc = paperClosedRes.data ?? []
      const lc = liveClosedRes.data ?? []

      const sumStats = (rows: { pnl: number }[]) => {
        const pnl    = rows.reduce((s, t) => s + (t.pnl ?? 0), 0)
        const wins   = rows.filter(t => (t.pnl ?? 0) > 0)
        const losses = rows.filter(t => (t.pnl ?? 0) < 0)
        const gw     = wins.reduce((s, t) => s + (t.pnl ?? 0), 0)
        const gl     = losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
        const best   = rows.length ? Math.max(...rows.map(t => t.pnl ?? 0)) : 0
        const worst  = rows.length ? Math.min(...rows.map(t => t.pnl ?? 0)) : 0
        const pf     = gl > 0 ? gw / gl : gw > 0 ? 99 : 0
        const wr     = rows.length > 0 ? Math.round(wins.length / rows.length * 100) : 0
        return { pnl, trades: rows.length, wins: wins.length, losses: losses.length, wr, pf, best, worst }
      }
      const ps = sumStats(pc)
      const ls = sumStats(lc)

      // Save to tb_daily_summary
      await db.from('tb_daily_summary').upsert([
        { date: today, broker: 'alpaca_paper', daily_pnl: ps.pnl, total_pnl: ps.pnl,
          wins: ps.wins, losses: ps.losses, win_rate: ps.wr,
          ending_balance: paper.balance, best_trade: ps.best, worst_trade: ps.worst, profit_factor: ps.pf },
        { date: today, broker: 'schwab', daily_pnl: ls.pnl, total_pnl: ls.pnl,
          wins: ls.wins, losses: ls.losses, win_rate: ls.wr,
          ending_balance: schwab.balance, best_trade: ls.best, worst_trade: ls.worst, profit_factor: ls.pf },
      ], { onConflict: 'date,broker' })

      // Send EOD TG report
      const fmt = (v: number) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)
      const tgMsg = [
        `📊 *EOD Report — ${today}*`,
        ``,
        `🔵 *Paper (Alpaca)*`,
        `P&L: ${fmt(ps.pnl)} | ${ps.trades} trades | ${ps.wins}W ${ps.losses}L | ${ps.wr}% win`,
        `PF: ${ps.pf >= 99 ? '—' : ps.pf.toFixed(2)} | Best: ${fmt(ps.best)} | Worst: ${fmt(ps.worst)}`,
        `Balance: $${paper.balance.toLocaleString()}`,
        ``,
        `🔴 *Live (Schwab)*`,
        `P&L: ${fmt(ls.pnl)} | ${ls.trades} trades | ${ls.wins}W ${ls.losses}L | ${ls.wr}% win`,
        `PF: ${ls.pf >= 99 ? '—' : ls.pf.toFixed(2)} | Best: ${fmt(ls.best)} | Worst: ${fmt(ls.worst)}`,
        `Balance: $${schwab.balance.toLocaleString()}`,
      ].join('\n')

      const botToken = process.env.TELEGRAM_BOT_TOKEN
      const chatId   = process.env.TELEGRAM_ALLOWED_CHAT_ID
      if (botToken && chatId) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: tgMsg, parse_mode: 'Markdown' }),
        }).catch(() => {})
      }

      await alertEODComparison({
        paper_pnl: ps.pnl, paper_balance: paper.balance,
        live_pnl: ls.pnl,  live_balance: schwab.balance,
        paper_wins: ps.wins, paper_losses: ps.losses,
        live_wins: ls.wins,  live_losses: ls.losses,
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
