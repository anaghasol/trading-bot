/**
 * CRON: /api/cron/monitor — monitors BOTH Schwab and Alpaca positions.
 * 5% trailing stop + partial exit at 2:1. Runs every 5 min via GitHub Actions.
 */
import { NextResponse } from 'next/server'
import * as SchwabBroker from '@/lib/schwab'
import * as AlpacaBroker from '@/lib/alpaca'
import { checkExitCondition, shouldTakePartial, isMarketOpen, isDailyLossExceeded, INITIAL_STOP_PCT } from '@/lib/risk'
import { profileFor } from '@/lib/strategy-profiles'
import { analyzePdtStatus } from '@/lib/pdt'
import { recordLearning } from '@/lib/learning'
import { alertStopHit, alertTelegramDown, alertTelegramReconnected } from '@/lib/notify'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

function today() { return new Date().toISOString().split('T')[0] }

function extractStopOrderId(reason: string): string | null {
  const m = reason?.match(/stop_id=(\w+)/)
  return m && m[1] !== 'n/a' ? m[1] : null
}

async function getEngineStatus(db: ReturnType<typeof createServiceClient>) {
  const { data } = await db.from('tb_context').select('key, value').in('key', ['engine_schwab', 'engine_alpaca'])
  return {
    schwab:       data?.find((r) => r.key === 'engine_schwab')?.value  ?? 'running',
    alpaca_paper: data?.find((r) => r.key === 'engine_alpaca')?.value  ?? 'running',
  }
}

async function monitorBroker(
  broker: 'schwab' | 'alpaca_paper',
  db: ReturnType<typeof createServiceClient>
): Promise<{ closed: number; partial: number; statuses: string[] }> {
  const api      = broker === 'schwab' ? SchwabBroker : AlpacaBroker
  const todayStr = today()

  const [positions, balance, recentOrders] = await Promise.all([
    api.getPositions(),
    api.getAccountBalance(),
    api.getOrders(7),
  ])

  if (positions.length === 0) return { closed: 0, partial: 0, statuses: [] }

  const equity = balance ?? (broker === 'schwab' ? 2000 : 100000)
  const pdt    = analyzePdtStatus(recentOrders, equity)

  const { data: acctRow } = await db.from('tb_account').select('daily_pnl, id').order('id', { ascending: false }).limit(1).single()
  const dailyPnl = acctRow?.daily_pnl ?? 0

  // Alpaca paper: no hard daily loss limit (it's fake money — let it ride to learn)
  if (broker === 'schwab' && isDailyLossExceeded(dailyPnl, equity)) {
    return { closed: 0, partial: 0, statuses: ['daily_loss_limit_hit'] }
  }

  // Load journal entries — filter by broker if column exists
  const { data: openTrades } = await db
    .from('tb_trades')
    .select('id, symbol, entry_price, peak_pnl, created_at, strategy, reason')
    .eq('status', 'OPEN')

  // Check for Telegram SELL signals in the last 2 hours (external signal reversal)
  const tgCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { data: tgSells } = await db
    .from('tb_alerts')
    .select('symbol')
    .eq('type', 'SELL')
    .gte('created_at', tgCutoff)
  const tgSellSymbols = new Set((tgSells ?? []).map((r) => r.symbol as string))

  const tradeMap = new Map<string, { id: number; entry_price: number; peak_price: number; initial_stop: number; entry_date: string; strategy: string; reason: string }>()
  for (const t of openTrades ?? []) {
    const ep         = t.entry_price ?? 0
    const peakPnlPct = (t.peak_pnl as number) ?? 0
    const stopMatch  = (t.reason as string)?.match(/stop=\$([0-9.]+)/)
    tradeMap.set(t.symbol, {
      id:           t.id,
      entry_price:  ep,
      peak_price:   ep > 0 ? ep * (1 + peakPnlPct / 100) : ep,
      initial_stop: stopMatch ? parseFloat(stopMatch[1]) : ep * (1 - INITIAL_STOP_PCT),
      entry_date:   (t.created_at as string)?.split('T')[0] ?? todayStr,
      strategy:     t.strategy ?? 'SWING',
      reason:       t.reason ?? '',
    })
  }

  let closed = 0, partial = 0, runningPnl = dailyPnl
  const statuses: string[] = []

  for (const pos of positions) {
    const meta = tradeMap.get(pos.symbol)
    if (!meta || !meta.entry_price) { statuses.push(`${pos.symbol}: no journal`); continue }

    const isSameDay   = meta.entry_date === todayStr
    const holdDays    = Math.round((Date.now() - new Date(meta.entry_date + 'T00:00:00Z').getTime()) / 86_400_000)
    const target_price = meta.entry_price * (1 + INITIAL_STOP_PCT * 2)

    // Partial exit at 2:1 (+5%)
    if (shouldTakePartial(pos.current_price, meta.entry_price, target_price, false)) {
      const canExit = broker === 'alpaca_paper' || !isSameDay || pdt.can_day_trade
      if (canExit) {
        const partialQty = Math.max(1, Math.floor(Math.abs(pos.quantity) * 0.5))
        const stopId = extractStopOrderId(meta.reason)
        if (stopId) await api.cancelOrder(stopId)

        const sellOrder = await api.placeOrder(pos.symbol, partialQty, pos.quantity > 0 ? 'SELL' : 'BUY')
        if (sellOrder.status === 'PLACED') {
          partial++
          const pnl = (pos.current_price - meta.entry_price) * partialQty
          runningPnl += pnl
          const gainPct = ((pos.current_price - meta.entry_price) / meta.entry_price) * 100

          if (meta.id) await db.from('tb_trades').update({ peak_pnl: Math.max((meta.peak_price > 0 ? ((meta.peak_price - meta.entry_price) / meta.entry_price) * 100 : 0), pos.pnl_pct), partial_exit_done: true }).eq('id', meta.id)
          if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningPnl }).eq('id', acctRow.id)

          const alertRow = { type: 'SELL', message: `[${broker}] PARTIAL ${partialQty} ${pos.symbol} @ $${pos.current_price.toFixed(2)} +${gainPct.toFixed(1)}% | $${pnl.toFixed(2)} locked`, symbol: pos.symbol, pnl }
          const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
          if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)

          statuses.push(`${pos.symbol}: PARTIAL +${gainPct.toFixed(1)}% $${pnl.toFixed(2)}`)
          continue
        }
      }
    }

    // External signal reversal: if Telegram sent a SELL on this symbol → exit
    if (tgSellSymbols.has(pos.symbol)) {
      const order = await api.placeOrder(pos.symbol, Math.abs(pos.quantity), pos.quantity > 0 ? 'SELL' : 'BUY')
      if (order.status === 'PLACED') {
        closed++
        runningPnl += pos.unrealized_pnl
        if (meta.id) await db.from('tb_trades').update({ status: 'CLOSED', exit_price: pos.current_price, pnl: pos.unrealized_pnl, pnl_pct: pos.pnl_pct, closed_at: new Date().toISOString() }).eq('id', meta.id)
        statuses.push(`${pos.symbol}: EXIT — Telegram SELL signal reversal | ${pos.pnl_pct.toFixed(1)}%`)
        continue
      }
    }

    // Full exit check — use broker profile's trail/stop settings + hard loss cap
    const profile = profileFor(broker)
    const exit = checkExitCondition(
      pos.current_price, meta.entry_price, meta.peak_price, meta.initial_stop,
      holdDays, false, profile.trail_pct, profile.max_hold_days,
      broker === 'alpaca_paper'
    )
    if (exit.new_peak_price > meta.peak_price && meta.id) {
      await db.from('tb_trades').update({ peak_pnl: ((exit.new_peak_price - meta.entry_price) / meta.entry_price) * 100 }).eq('id', meta.id)
    }

    if (!exit.should_exit) { statuses.push(`${pos.symbol}: ${exit.reason}`); continue }

    // PDT gate for Schwab same-day exits only
    const isEmergency = exit.exit_type === 'INITIAL_STOP' && exit.pnl_pct < -6
    if (broker === 'schwab' && isSameDay && !pdt.can_day_trade && !isEmergency) {
      statuses.push(`${pos.symbol}: ${exit.exit_type} but PDT exhausted — holding overnight`)
      continue
    }

    const order = await api.placeOrder(pos.symbol, Math.abs(pos.quantity), pos.quantity > 0 ? 'SELL' : 'BUY')
    if (order.status === 'PLACED') {
      closed++
      const pnl = pos.unrealized_pnl
      runningPnl += pnl

      if (meta.id) await db.from('tb_trades').update({ status: 'CLOSED', exit_price: pos.current_price, pnl, pnl_pct: exit.pnl_pct, days_held: holdDays, closed_at: new Date().toISOString() }).eq('id', meta.id)
      if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningPnl }).eq('id', acctRow.id)
      await recordLearning({ symbol: pos.symbol, strategy: meta.strategy, pnl_pct: exit.pnl_pct, hold_days: holdDays, regime: 'NORMAL' })

      const alertRow = { type: pnl >= 0 ? 'SELL' : 'STOP_LOSS', message: `[${broker}] ${exit.exit_type} ${pos.symbol} | ${exit.reason} | $${pnl.toFixed(2)}`, symbol: pos.symbol, pnl }
      const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
      if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)

      // SMS alert for real Schwab exits
      await alertStopHit({
        broker: broker as 'schwab' | 'alpaca_paper',
        symbol: pos.symbol, qty: Math.abs(pos.quantity),
        pnl, pnl_pct: exit.pnl_pct, exit_type: exit.exit_type,
      })

      statuses.push(`${pos.symbol}: CLOSED ${exit.exit_type} $${pnl.toFixed(2)}`)
    }
  }

  // P&L snapshot
  const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10)
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pnl, 0)
  const snapRow = { date: todayStr, hour: etHour, balance: equity, daily_pnl: runningPnl + unrealized }
  const { error: se } = await db.from('tb_pnl_snapshots').upsert({ ...snapRow, broker }, { onConflict: 'date,hour' })
  if (se?.code === 'PGRST204') await db.from('tb_pnl_snapshots').upsert(snapRow, { onConflict: 'date,hour' })

  return { closed, partial, statuses }
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isMarketOpen()) return NextResponse.json({ status: 'skipped', reason: 'market_closed' })

  const db = createServiceClient()
  const engines = await getEngineStatus(db)
  const start = Date.now()
  const results: Record<string, unknown> = {}

  const tasks: Promise<void>[] = []

  if (engines.schwab === 'running') {
    tasks.push(
      monitorBroker('schwab', db).then((r) => {
        results.schwab = r
        return db.from('tb_cron_log').insert({ job: 'monitor', status: 'success', trades_made: r.closed + r.partial, message: `[schwab] closed:${r.closed} partial:${r.partial} | ${r.statuses.join(' | ')}`, duration_ms: Date.now() - start }).then(() => {})
      }).catch((e) => { results.schwab = { error: e.message } })
    )
  }

  if (engines.alpaca_paper === 'running') {
    tasks.push(
      monitorBroker('alpaca_paper', db).then((r) => {
        results.alpaca_paper = r
        return db.from('tb_cron_log').insert({ job: 'monitor', status: 'success', trades_made: r.closed + r.partial, message: `[alpaca] closed:${r.closed} partial:${r.partial} | ${r.statuses.join(' | ')}`, duration_ms: Date.now() - start }).then(() => {})
      }).catch((e) => { results.alpaca_paper = { error: e.message } })
    )
  }

  await Promise.allSettled(tasks)

  // ── Telegram health check ──────────────────────────────────────────────────
  // Runs every 5 min. If Railway poller hasn't checked in for >5 min → SMS once per hour.
  try {
    const [pollRow, lastAlertRow] = await Promise.all([
      db.from('tb_settings').select('value').eq('key', 'tg_last_poll').single(),
      db.from('tb_settings').select('value').eq('key', 'tg_down_alerted_at').single(),
    ])
    const lastPoll   = pollRow.data?.value ? new Date(pollRow.data.value) : null
    const minutesSilent = lastPoll ? Math.round((Date.now() - lastPoll.getTime()) / 60000) : 999
    const lastAlerted   = lastAlertRow.data?.value ? new Date(lastAlertRow.data.value) : null
    const alertCooldown = lastAlerted ? (Date.now() - lastAlerted.getTime()) / 60000 : 999

    if (minutesSilent > 5) {
      if (alertCooldown > 60) {
        // First alert this hour — SMS and record
        await alertTelegramDown(minutesSilent)
        await db.from('tb_settings').upsert({ key: 'tg_down_alerted_at', value: new Date().toISOString() })
        await db.from('tb_settings').upsert({ key: 'tg_status', value: `down:${minutesSilent}min` })
      }
    } else {
      // Poller is healthy — clear error state
      if (lastAlerted) {
        // Was down before → SMS reconnect
        await alertTelegramReconnected()
        await db.from('tb_settings').delete().eq('key', 'tg_down_alerted_at')
      }
      await db.from('tb_settings').upsert({ key: 'tg_status', value: 'ok' })
    }
  } catch { /* don't crash monitor if TG check fails */ }

  return NextResponse.json({ status: 'ok', engines, results, duration_ms: Date.now() - start })
}
