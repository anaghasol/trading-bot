/**
 * CRON: /api/cron/monitor — monitors BOTH Schwab and Alpaca positions.
 * 5% trailing stop + partial exit at 2:1. Runs every 5 min via GitHub Actions.
 */
import { NextResponse } from 'next/server'
import * as SchwabBroker from '@/lib/schwab'
import * as AlpacaBroker from '@/lib/alpaca'
import { checkExitCondition, shouldTakePartial, isMarketOpen, isDailyLossExceeded, INITIAL_STOP_PCT } from '@/lib/risk'
import { evaluateOptionsExit } from '@/lib/options-exit'
import { profileFor } from '@/lib/strategy-profiles'
import { analyzePdtStatus } from '@/lib/pdt'
import { recordLearning } from '@/lib/learning'
import { getActiveIntentions } from '@/lib/tg-intentions'
import { alertStopHit, alertTelegramDown, alertTelegramReconnected, alertPreMarket, alertSchwabTokenExpiry } from '@/lib/notify'
import { getSchwabAuthStatus } from '@/lib/schwab'
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
  // Distributed lock — prevents overlapping 5-min cron runs from double-selling.
  // 90s expiry: maxDuration is 60s so a 90s stale lock means the previous run crashed.
  const lockKey = `monitor_lock_${broker}`
  try {
    const { data: lock } = await db.from('tb_settings').select('value').eq('key', lockKey).single()
    if (lock?.value) {
      const ageMs = Date.now() - new Date(lock.value).getTime()
      if (ageMs < 90_000) {
        return { closed: 0, partial: 0, statuses: [`skipped — monitor already running (${Math.floor(ageMs / 1000)}s ago)`] }
      }
      if (ageMs > 300_000) {
        console.warn(`[monitor][${broker}] Stale lock ${Math.floor(ageMs / 60000)}m — force-clearing`)
        void db.from('tb_alerts').insert({ type: 'WARN', message: `[${broker}] monitor stale lock cleared (${Math.floor(ageMs / 60000)}m old)` })
      }
    }
    await db.from('tb_settings').upsert({ key: lockKey, value: new Date().toISOString() })
  } catch { /* lock failure is non-fatal — proceed */ }

  const api      = broker === 'schwab' ? SchwabBroker : AlpacaBroker
  const todayStr = today()

  const [positions, balance, recentOrders] = await Promise.all([
    api.getPositions(),
    api.getAccountBalance(),
    api.getOrders(7),
  ])

  // Even with no live positions, run orphan reconciliation (positions may have closed via broker stop orders)
  if (positions.length === 0) {
    void db.from('tb_settings').upsert({ key: lockKey, value: '' })
    return { closed: 0, partial: 0, statuses: [] }
  }

  // Load Pavan's hold intentions — if he says "don't exit TEM", we skip our own stops for it
  const intentions = await getActiveIntentions().catch(() => [])
  const holdSymbols = new Set(intentions.filter((i) => i.type === 'hold_position').map((i) => i.symbol))

  const equity = balance ?? (broker === 'schwab' ? 2000 : 100000)
  const pdt    = analyzePdtStatus(recentOrders, equity)

  // Compute today's realized P/L fresh from tb_trades — never trust stale tb_account.daily_pnl.
  const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00Z'
  const { data: todayClosedRows } = await db
    .from('tb_trades')
    .select('pnl')
    .eq('status', 'CLOSED')
    .gte('closed_at', todayStart)
    .or(`broker.eq.${broker},broker.is.null`)
  const dailyPnl = (todayClosedRows ?? []).reduce((s, t) => s + ((t.pnl as number) ?? 0), 0)
  const { data: acctRow } = await db.from('tb_account').select('id').order('id', { ascending: false }).limit(1).single()

  // Alpaca paper: no hard daily loss limit (it's fake money — let it ride to learn)
  if (broker === 'schwab' && isDailyLossExceeded(dailyPnl, equity)) {
    return { closed: 0, partial: 0, statuses: [`daily_loss_limit_hit (realized today: $${dailyPnl.toFixed(2)})`] }
  }

  // Load THIS BROKER'S open trades only.
  // Without the broker filter, both monitors run in parallel and the Schwab monitor
  // would orphan-reconcile Alpaca trades (not in Schwab positions → marks them CLOSED),
  // then the Alpaca monitor can't find them. Include null-broker rows for legacy trades.
  const { data: openTrades } = await db
    .from('tb_trades')
    .select('id, symbol, entry_price, peak_pnl, created_at, strategy, reason')
    .eq('status', 'OPEN')
    .or(`broker.eq.${broker},broker.is.null`)

  // Check for Telegram SELL signals in the last 2 hours (external signal reversal)
  const tgCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { data: tgSells } = await db
    .from('tb_alerts')
    .select('symbol')
    .eq('type', 'SELL')
    .gte('created_at', tgCutoff)
  const tgSellSymbols = new Set((tgSells ?? []).map((r) => r.symbol as string))

  // Both partial-exit flags stored in tb_settings (no schema column needed).
  // p1done_{id} = first partial taken; p2done_{id} = second partial taken.
  const tradeIds = (openTrades ?? []).map((t) => String(t.id))
  const partialKeys = tradeIds.flatMap((id) => [`p1done_${id}`, `p2done_${id}`])
  const { data: partialRows } = partialKeys.length
    ? await db.from('tb_settings').select('key, value').in('key', partialKeys)
    : { data: [] }
  const partialSet = new Set((partialRows ?? []).filter((r) => r.value).map((r) => r.key))

  const tradeMap = new Map<string, { id: number; entry_price: number; peak_price: number; initial_stop: number; entry_date: string; strategy: string; reason: string; hold_mode: 'day' | 'swing' | 'trend'; partial_done: boolean; p2_done: boolean }>()
  for (const t of openTrades ?? []) {
    const ep         = t.entry_price ?? 0
    const peakPnlPct = (t.peak_pnl as number) ?? 0
    const stopMatch  = (t.reason as string)?.match(/stop=\$([0-9.]+)/)
    const holdModeMatch = (t.reason as string)?.match(/hold_mode=(\w+)/)
    tradeMap.set(t.symbol, {
      id:           t.id,
      entry_price:  ep,
      peak_price:   ep > 0 ? ep * (1 + peakPnlPct / 100) : ep,
      initial_stop: stopMatch ? parseFloat(stopMatch[1]) : ep * (1 - INITIAL_STOP_PCT),
      entry_date:   (t.created_at as string)?.split('T')[0] ?? todayStr,
      strategy:     t.strategy ?? 'SWING',
      reason:       t.reason ?? '',
      hold_mode:    (holdModeMatch?.[1] ?? 'swing') as 'day' | 'swing' | 'trend',
      partial_done: partialSet.has(`p1done_${t.id}`),
      p2_done:      partialSet.has(`p2done_${t.id}`),
    })
  }

  // ── Orphan reconciliation ──────────────────────────────────────────────────
  // If a symbol is OPEN in tb_trades but absent from broker positions, the broker's
  // stop-loss order fired and filled without us updating the database.
  // Mark these as CLOSED so the dashboard doesn't show phantom positions.
  const liveSymbols = new Set(positions.map((p) => p.symbol))
  for (const [sym, meta] of Array.from(tradeMap.entries())) {
    if (!liveSymbols.has(sym)) {
      // Position no longer at broker → estimate exit via recent broker order history
      try {
        // Cast to unknown records to handle both Schwab and Alpaca order shapes
        const anyOrders = recentOrders as unknown as Record<string, unknown>[]
        const recentFilled = anyOrders.find(
          (o) => o.symbol === sym
            && (String(o.instruction ?? o.side ?? '').toUpperCase() === 'SELL')
            && String(o.status ?? '').toLowerCase().includes('fill')
        )
        // Schwab uses `price`, Alpaca uses `filled_avg_price`
        const exitPrice   = recentFilled ? parseFloat(String(recentFilled.filled_avg_price ?? recentFilled.price ?? 0)) : 0
        const estimatedPnl = 0  // qty unknown at this point — log only, P&L will be 0
        const pnlPct       = meta.entry_price > 0 && exitPrice > 0 ? ((exitPrice - meta.entry_price) / meta.entry_price) * 100 : 0

        await db.from('tb_trades').update({
          status: 'CLOSED', exit_price: exitPrice || null,
          pnl: estimatedPnl || null, pnl_pct: pnlPct || null,
          closed_at: String(recentFilled?.filled_at ?? recentFilled?.close_time ?? new Date().toISOString()),
          reason: (meta.reason ?? '') + ' [auto-reconciled: broker stop filled]',
        }).eq('id', meta.id)

        const alertMsg = `[${broker}] AUTO-RECONCILE ${sym}: position gone from broker — marked CLOSED${exitPrice ? ` @ $${exitPrice.toFixed(2)} (${pnlPct.toFixed(1)}%)` : ' (exit price unknown)'}`
        void db.from('tb_alerts').insert({ type: 'INFO', symbol: sym, message: alertMsg })
        console.log(alertMsg)
      } catch { /* reconcile failure is non-fatal */ }
    }
  }

  // ── Orphan naked short cleanup (paper only) ───────────────────────────────
  // If any options position has qty < 0 with NO journal entry, close it immediately.
  // This catches accidental shorts created by TG race conditions or bad order routing.
  if (broker === 'alpaca_paper') {
    for (const pos of positions) {
      if (pos.asset_type === 'OPTION' && pos.quantity < 0 && !tradeMap.has(pos.symbol)) {
        const order = await AlpacaBroker.closePosition(pos.symbol)
        const msg = `[AUTO] Orphan naked short ${pos.symbol} qty=${pos.quantity} — closed${order.status === 'PLACED' ? ' OK' : ' FAILED'}`
        void db.from('tb_alerts').insert({ type: 'STOP_LOSS', symbol: pos.symbol, broker, message: msg })
        console.log(msg)
      }
    }
  }

  let closed = 0, partial = 0, runningPnl = dailyPnl
  const statuses: string[] = []

  for (const pos of positions) {
    const meta = tradeMap.get(pos.symbol)
    if (!meta || !meta.entry_price) { statuses.push(`${pos.symbol}: no journal`); continue }

    // ── OPTIONS: separate exit logic ──────────────────────────────────────────
    if (pos.asset_type === 'OPTION') {
      // Only trade options on paper — never touch live Schwab account with options
      if (broker !== 'alpaca_paper') { statuses.push(`${pos.symbol}: options skipped on live account`); continue }

      // Recover raw OCC symbol from reason (needed for Alpaca order)
      const rawMatch  = (meta.reason ?? '').match(/raw_symbol=([^\s|]+)/)
      const rawSymbol = rawMatch ? rawMatch[1] : pos.symbol
      const expiryMatch = (meta.reason ?? '').match(/option_expiry=(\d{4}-\d{2}-\d{2})/)
      const expiry    = expiryMatch ? expiryMatch[1] : pos.option_expiry
      const premPct   = pos.pnl_pct
      const pnlStr    = `${pos.unrealized_pnl >= 0 ? '+' : ''}$${pos.unrealized_pnl.toFixed(0)}`
      const dteDays   = expiry ? (new Date(expiry).getTime() - Date.now()) / 86_400_000 : 999

      const exitDecision = evaluateOptionsExit(
        { symbol: pos.symbol, quantity: pos.quantity, pnl_pct: premPct, option_expiry: expiry ?? undefined },
        !!meta.partial_done
      )

      if (exitDecision.action === 'PARTIAL_CLOSE') {
        const partialQty = exitDecision.partialQty!
        const sellOrder  = await AlpacaBroker.closePosition(rawSymbol)
        if (sellOrder.status === 'PLACED') {
          partial++
          if (meta.id) await db.from('tb_settings').upsert({ key: `p1done_${meta.id}`, value: new Date().toISOString() })
          await db.from('tb_alerts').insert({ type: 'SELL', symbol: pos.symbol, broker, message: `[paper] OPT PARTIAL-1 ${partialQty}x ${pos.symbol} +${premPct.toFixed(0)}% | ${pnlStr}` })
          statuses.push(`${pos.symbol}: OPT PARTIAL-1 +${premPct.toFixed(0)}% ${pnlStr}`)
        }
        continue
      }

      if (exitDecision.action === 'FULL_CLOSE') {
        const optExitReason = exitDecision.reason!
        const sellOrder = await AlpacaBroker.closePosition(rawSymbol)
        if (sellOrder.status === 'PLACED') {
          closed++
          runningPnl += pos.unrealized_pnl
          if (meta.id) await db.from('tb_trades').update({ status: 'CLOSED', exit_price: pos.current_price, pnl: pos.unrealized_pnl, pnl_pct: premPct, closed_at: new Date().toISOString() }).eq('id', meta.id)
          await db.from('tb_alerts').insert({ type: premPct >= 0 ? 'SELL' : 'STOP_LOSS', symbol: pos.symbol, broker, message: `[paper] ${optExitReason} ${pos.symbol} | ${pnlStr}` })
          const tgBot = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_ALLOWED_CHAT_ID
          if (tgBot && tgChat) {
            const emoji = premPct >= 0 ? '💰' : '🛑'
            await fetch(`https://api.telegram.org/bot${tgBot}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tgChat, text: `${emoji} *Options exit (paper)*\n${pos.symbol}\n${optExitReason}\nP/L: ${pnlStr} (${premPct.toFixed(0)}% on premium)`, parse_mode: 'Markdown' }) }).catch(() => {})
          }
          statuses.push(`${pos.symbol}: OPT CLOSED ${optExitReason} ${pnlStr}`)
        }
        continue
      }

      statuses.push(`${pos.symbol}: OPT holding ${premPct.toFixed(1)}% | ${Math.floor(dteDays)}d left`)
      continue
    }

    const isSameDay   = meta.entry_date === todayStr
    const holdDays    = Math.round((Date.now() - new Date(meta.entry_date + 'T00:00:00Z').getTime()) / 86_400_000)
    const gainPct     = pos.pnl_pct

    // ── Staged Exit Intelligence ───────────────────────────────────────────────
    // Three-tier profit taking based on current gain. Each tier fires once per trade.
    //
    //   Tier 1 (paper +8%, live +7%)  → sell 50%  — lock in the core gain
    //   Tier 2 (paper +15%, live +12%)→ sell 50% of remaining — capture the extended move
    //   Big-win lock (paper +20%, live+15%) → exit 100% remaining — don't ride a rocket back down
    //
    // After each tier the trailing stop (via checkExitCondition) handles the remaining shares.
    // Tier state: partial_done (tb_trades column) for tier 1; p2done_{id} (tb_settings) for tier 2.

    // Partial exit thresholds — Schwab (live small account) needs higher bars
    // to avoid killing winners. Paper has more positions so partials happen sooner.
    const P1_PCT = broker === 'schwab' ? 15 : 8   // live: 15% before first partial
    const P2_PCT = broker === 'schwab' ? 25 : 15  // live: 25% before second partial

    const canExit   = broker === 'alpaca_paper' || !isSameDay || pdt.can_day_trade
    const noHold    = !holdSymbols.has(pos.symbol)

    // Momentum-aware partial sizing — sell LESS when the stock is running hardest.
    // Schwab (live, small account): even more conservative — max 20% on rockets.
    //   paper  gain < 20%  → 50% | 20–35% → 25% | >35% → 15%
    //   schwab gain < 20%  → 33% | 20–35% → 20% | >35% → 10%
    const partialFrac = broker === 'schwab'
      ? (gainPct > 35 ? 0.10 : gainPct > 20 ? 0.20 : 0.33)
      : (gainPct > 35 ? 0.15 : gainPct > 20 ? 0.25 : 0.50)

    // Tier 1 — first partial
    if (!meta.partial_done && gainPct >= P1_PCT && canExit) {
      const partialQty = Math.max(1, Math.floor(Math.abs(pos.quantity) * partialFrac))
      const pct_label  = `${Math.round(partialFrac * 100)}%`
      // Cancel any open bracket/stop orders before selling — Alpaca rejects partial sells with conflicting orders
      if (broker === 'alpaca_paper') await AlpacaBroker.cancelOpenOrdersFor(pos.symbol)
      else { const stopId = extractStopOrderId(meta.reason); if (stopId) await api.cancelOrder(stopId) }

      const sellOrder = await api.placeOrder(pos.symbol, partialQty, pos.quantity > 0 ? 'SELL' : 'BUY')
      if (sellOrder.status === 'PLACED') {
        partial++
        const pnl = (pos.current_price - meta.entry_price) * partialQty
        runningPnl += pnl

        if (meta.id) {
          await db.from('tb_trades').update({ peak_pnl: Math.max((meta.peak_price > 0 ? ((meta.peak_price - meta.entry_price) / meta.entry_price) * 100 : 0), gainPct) }).eq('id', meta.id)
          await db.from('tb_settings').upsert({ key: `p1done_${meta.id}`, value: new Date().toISOString() })
        }
        if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningPnl }).eq('id', acctRow.id)

        const alertRow = { type: 'SELL', message: `[${broker}] PARTIAL-1 (${pct_label}) ${partialQty} ${pos.symbol} @ $${pos.current_price.toFixed(2)} +${gainPct.toFixed(1)}% | $${pnl.toFixed(2)} locked — trailing ${Math.round((1 - partialFrac) * 100)}%`, symbol: pos.symbol, pnl }
        const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
        if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)

        statuses.push(`${pos.symbol}: PARTIAL-1 ${pct_label} +${gainPct.toFixed(1)}% $${pnl.toFixed(2)}`)
        continue
      }
    }

    // Tier 2 — second partial (33% of what's left — preserve most for trailing stop)
    if (meta.partial_done && !meta.p2_done && gainPct >= P2_PCT && canExit && noHold) {
      const partialQty = Math.max(1, Math.floor(Math.abs(pos.quantity) * 0.33))
      if (broker === 'alpaca_paper') await AlpacaBroker.cancelOpenOrdersFor(pos.symbol)
      const sellOrder = await api.placeOrder(pos.symbol, partialQty, pos.quantity > 0 ? 'SELL' : 'BUY')
      if (sellOrder.status === 'PLACED') {
        partial++
        const pnl = (pos.current_price - meta.entry_price) * partialQty
        runningPnl += pnl

        await db.from('tb_settings').upsert({ key: `p2done_${meta.id}`, value: new Date().toISOString() })
        if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningPnl }).eq('id', acctRow.id)

        const alertRow = { type: 'SELL', message: `[${broker}] PARTIAL-2 (33% remaining) ${partialQty} ${pos.symbol} @ $${pos.current_price.toFixed(2)} +${gainPct.toFixed(1)}% | $${pnl.toFixed(2)} locked — trailing 67%`, symbol: pos.symbol, pnl }
        const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
        if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)

        statuses.push(`${pos.symbol}: PARTIAL-2 +${gainPct.toFixed(1)}% $${pnl.toFixed(2)}`)
        continue
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

    // Flat recycling (paper only): if a position has been stuck within ±2% for 2+ calendar days,
    // close it and free the slot for a fresh setup. Winners and trend holds are exempt.
    if (broker === 'alpaca_paper' && holdDays >= 2 && Math.abs(gainPct) < 2 && meta.hold_mode !== 'trend') {
      const order = await AlpacaBroker.closePosition(pos.symbol)
      if (order.status === 'PLACED') {
        closed++
        runningPnl += pos.unrealized_pnl
        if (meta.id) await db.from('tb_trades').update({ status: 'CLOSED', exit_price: pos.current_price, pnl: pos.unrealized_pnl, pnl_pct: pos.pnl_pct, days_held: holdDays, closed_at: new Date().toISOString() }).eq('id', meta.id)
        void db.from('tb_alerts').insert({ type: 'SELL', symbol: pos.symbol, broker, message: `[FLAT_RECYCLE] ${pos.symbol} closed: ${holdDays}d held, ${gainPct.toFixed(1)}% — slot freed for new setup` })
        statuses.push(`${pos.symbol}: FLAT_RECYCLE — ${holdDays}d, ${gainPct.toFixed(1)}%`)
        continue
      }
    }

    // Full exit check — hold_mode determines trail width and calendar limit
    //   trend: starts at 8% trail, tightens to 4% once up 30%, floor at breakeven once up 8%
    //   day:   tight 3% trail, must exit by EOD (handled by close cron)
    //   swing: profile default (5% trail, max_hold_days cap)
    const profile = profileFor(broker)
    const isTrend = meta.hold_mode === 'trend'
    const isDay   = meta.hold_mode === 'day'

    // Trend trail ladder: wide early, tighten as gains compound
    //   +0%  to +30%: 8% trail — give room to run
    //   +30% and up:  4% trail — lock most of the gain, still let it run further
    const effectiveTrail   = isTrend
      ? (gainPct >= 30 ? 0.04 : 0.08)
      : isDay ? 0.03 : profile.trail_pct
    const effectiveMaxHold = isTrend ? 999  : profile.max_hold_days  // trend: never force-close on calendar

    // Trend breakeven floor: once up 6%, floor the initial stop at entry price.
    // Many strong trends pull back 6-10% before continuing — protect early.
    const effectiveInitialStop = isTrend && gainPct >= 6
      ? Math.max(meta.initial_stop, meta.entry_price)
      : meta.initial_stop

    const exit = checkExitCondition(
      pos.current_price, meta.entry_price, meta.peak_price, effectiveInitialStop,
      holdDays, false, effectiveTrail, effectiveMaxHold,
      broker === 'alpaca_paper'
    )
    if (exit.new_peak_price > meta.peak_price && meta.id) {
      await db.from('tb_trades').update({ peak_pnl: ((exit.new_peak_price - meta.entry_price) / meta.entry_price) * 100 }).eq('id', meta.id)
    }

    if (!exit.should_exit) {
      const trailLabel = isTrend
        ? (gainPct >= 30 ? '[TREND 4%trail 🔒]' : gainPct >= 6 ? '[TREND 8%trail BE🛡]' : '[TREND 8%trail]')
        : isDay ? '[DAY 3%trail]' : ''
      statuses.push(`${pos.symbol}: ${exit.reason} ${trailLabel}`.trim())
      continue
    }

    // Pavan said hold — override our trailing stop (but NOT emergency initial-stop loss)
    const isEmergencyStop = exit.exit_type === 'INITIAL_STOP' && exit.pnl_pct < -6
    if (holdSymbols.has(pos.symbol) && !isEmergencyStop) {
      statuses.push(`${pos.symbol}: HOLD override — Pavan says don't exit (${exit.exit_type})`)
      continue
    }

    // PDT gate for Schwab same-day exits only
    const isEmergency = exit.exit_type === 'INITIAL_STOP' && exit.pnl_pct < -6
    if (broker === 'schwab' && isSameDay && !pdt.can_day_trade && !isEmergency) {
      statuses.push(`${pos.symbol}: ${exit.exit_type} but PDT exhausted — holding overnight`)
      continue
    }

    // For Alpaca paper: use DELETE /positions endpoint — atomically cancels any open
    // bracket/stop orders AND closes the position. Avoids "conflicting order" rejection
    // that causes stops to silently fail when a bracket order is already active.
    const order = broker === 'alpaca_paper'
      ? await AlpacaBroker.closePosition(pos.symbol)
      : await api.placeOrder(pos.symbol, Math.abs(pos.quantity), pos.quantity > 0 ? 'SELL' : 'BUY')
    if (order.status === 'PLACED') {
      closed++
      const pnl = pos.unrealized_pnl
      runningPnl += pnl

      if (meta.id) await db.from('tb_trades').update({ status: 'CLOSED', exit_price: pos.current_price, pnl, pnl_pct: exit.pnl_pct, days_held: holdDays, closed_at: new Date().toISOString() }).eq('id', meta.id)
      if (acctRow?.id) await db.from('tb_account').update({ daily_pnl: runningPnl }).eq('id', acctRow.id)
      await recordLearning({
        symbol:     pos.symbol,
        strategy:   meta.strategy,
        pnl_pct:    exit.pnl_pct,
        hold_days:  holdDays,
        regime:     'NORMAL',
        exit_type:  exit.exit_type,
        exit_price: pos.current_price,
        entry_price: meta.entry_price,
        hold_mode:  meta.hold_mode,
        confidence: undefined,
        reason:     meta.reason,
        broker,
      })

      const alertRow = { type: pnl >= 0 ? 'SELL' : 'STOP_LOSS', message: `[${broker}] ${exit.exit_type} ${pos.symbol} | ${exit.reason} | $${pnl.toFixed(2)}`, symbol: pos.symbol, pnl }
      const { error: ae } = await db.from('tb_alerts').insert({ ...alertRow, broker })
      if (ae?.code === 'PGRST204') await db.from('tb_alerts').insert(alertRow)

      // SMS alert for real Schwab exits
      await alertStopHit({
        broker: broker as 'schwab' | 'alpaca_paper',
        symbol: pos.symbol, qty: Math.abs(pos.quantity),
        pnl, pnl_pct: exit.pnl_pct, exit_type: exit.exit_type,
      })

      // Re-entry window: if this was a stop-loss (not profit-take), mark it as a re-entry
      // candidate. The next scan tick will boost this symbol's confidence by +5 if AI still
      // likes it — enabling the "re-enter within 1 hour if thesis still valid" behavior.
      if (pnl < 0 && exit.exit_type !== 'TARGET') {
        void db.from('tb_settings').upsert({
          key: `reentry_candidate_${broker}_${pos.symbol}`,
          value: JSON.stringify({ closed_at: new Date().toISOString(), close_price: pos.current_price, pnl_pct: exit.pnl_pct, hold_mode: meta.hold_mode }),
        })
      }

      statuses.push(`${pos.symbol}: CLOSED ${exit.exit_type} $${pnl.toFixed(2)}${pnl < 0 ? ' [reentry eligible]' : ''}`)
    }
  }

  // P&L snapshot
  const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10)
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pnl, 0)
  const snapRow = { date: todayStr, hour: etHour, balance: equity, daily_pnl: runningPnl + unrealized }
  const { error: se } = await db.from('tb_pnl_snapshots').upsert({ ...snapRow, broker }, { onConflict: 'date,hour' })
  if (se?.code === 'PGRST204') await db.from('tb_pnl_snapshots').upsert(snapRow, { onConflict: 'date,hour' })

  void db.from('tb_settings').upsert({ key: lockKey, value: '' })  // release lock

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

  // ── Schwab token expiry check ─────────────────────────────────────────────
  // SMS alert once when refresh token < 24h from expiry so re-auth happens before it breaks
  try {
    const authStatus = await getSchwabAuthStatus()
    if (authStatus.ok && authStatus.hours_left !== null && authStatus.hours_left <= 24) {
      const { data: alreadyAlerted } = await db.from('tb_settings').select('value').eq('key', 'schwab_expiry_alerted').single()
      if (!alreadyAlerted?.value) {
        await alertSchwabTokenExpiry(authStatus.hours_left)  // proper SMS — alertPreMarket skips if setups=0
        await db.from('tb_alerts').insert({ type: 'WARN', symbol: null, message: `🔐 Schwab token expires in ${authStatus.hours_left}h — re-authorize at /settings before trading stops` })
        await db.from('tb_settings').upsert({ key: 'schwab_expiry_alerted', value: new Date().toISOString() })
      }
    } else if (authStatus.hours_left !== null && authStatus.hours_left > 24) {
      // Clear the alert flag once renewed
      await db.from('tb_settings').delete().eq('key', 'schwab_expiry_alerted')
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({ status: 'ok', engines, results, duration_ms: Date.now() - start })
}
