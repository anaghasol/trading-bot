/**
 * PDT (Pattern Day Trader) rule tracker.
 *
 * Rule: Account under $25,000 can make at most 3 "day trades" in any
 * rolling 5-business-day window. A day trade = buying AND selling the
 * same security on the same calendar day (in a margin account).
 *
 * Strategy: We use SWING TRADING to stay compliant:
 *   - Buy on day N, sell on day N+1 or later = NOT a day trade
 *   - Only sell same-day as a last resort (stop-loss emergency)
 *   - Reserve 1 day-trade slot for genuine stop-losses
 */

import type { SchwabOrder } from './schwab'

export interface PdtStatus {
  day_trades_used: number
  day_trades_remaining: number
  can_day_trade: boolean
  is_swing_mode: boolean
  balance: number
  is_pdt_protected: boolean   // true = under $25K, PDT rules apply
  window_start: string
  window_end: string
  today_trades: string[]      // symbols bought today (can't same-day sell)
}

const PDT_THRESHOLD = 25_000
const MAX_DAY_TRADES = 3
const WINDOW_DAYS    = 5

function getTradingDaysBack(n: number): Date[] {
  const days: Date[] = []
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)

  while (days.length < n) {
    const dow = cursor.getDay()
    if (dow !== 0 && dow !== 6) days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() - 1)
  }
  return days
}

function dateStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

export function analyzePdtStatus(orders: SchwabOrder[], balance: number): PdtStatus {
  const isProtected = balance < PDT_THRESHOLD
  const today       = dateStr(new Date())

  if (!isProtected) {
    return {
      day_trades_used: 0,
      day_trades_remaining: 999,
      can_day_trade: true,
      is_swing_mode: false,
      balance,
      is_pdt_protected: false,
      window_start: '',
      window_end: today,
      today_trades: [],
    }
  }

  const windowDays = getTradingDaysBack(WINDOW_DAYS)
  const windowStart = dateStr(windowDays[windowDays.length - 1])
  const windowDates = new Set(windowDays.map(dateStr))

  // Group FILLED orders by date → symbol → actions
  const byDateSym = new Map<string, { bought: boolean; sold: boolean }>()

  for (const order of orders) {
    if (order.status !== 'FILLED') continue
    const d = order.entered_time ? order.entered_time.split('T')[0] : ''
    if (!windowDates.has(d)) continue
    const key = `${d}|${order.symbol}`
    const cur = byDateSym.get(key) ?? { bought: false, sold: false }
    if (order.instruction === 'BUY')  cur.bought = true
    if (order.instruction === 'SELL') cur.sold   = true
    byDateSym.set(key, cur)
  }

  const dayTradeCount = Array.from(byDateSym.values()).filter((v) => v.bought && v.sold).length

  // Symbols bought today (can't sell same day without using a day-trade slot)
  const todayBuys = orders
    .filter((o) => o.entered_time?.startsWith(today) && o.instruction === 'BUY' && o.status === 'FILLED')
    .map((o) => o.symbol)

  return {
    day_trades_used:      dayTradeCount,
    day_trades_remaining: Math.max(0, MAX_DAY_TRADES - dayTradeCount),
    can_day_trade:        dayTradeCount < MAX_DAY_TRADES,
    is_swing_mode:        true,
    balance,
    is_pdt_protected:     true,
    window_start:         windowStart,
    window_end:           today,
    today_trades:         todayBuys,
  }
}

// ── Swing strategy parameters ─────────────────────────────────────────────────

export const SWING_CONFIG = {
  max_positions:        3,
  position_size_pct:    0.28,    // 28% per position — 3 positions = 84%, keeps 16% cash
  stop_loss_pct:       -5.0,
  profit_target_pct:   10.0,     // Take partial at +10%, let rest run to +15-20%
  max_hold_days:        5,       // Force exit after 5 days
  trailing_start_pct:  5.0,      // Start trailing at +5%
  trailing_pct:        3.0,      // Trail by 3%
  same_day_emergency_stop: -7.0, // Only sell same-day if down -7% (uses day-trade slot)
}
