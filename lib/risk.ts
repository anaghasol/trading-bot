/**
 * Core risk engine — trailing stop + position sizing.
 *
 * Rules (reconciled so code == docs):
 * - Position size: risk 1.5% of equity per trade (baseline; sleeves.ts scales per horizon)
 * - Initial stop: 2.5% below entry (tight, protect capital)
 * - Trailing stop: 5% from peak (locks in profits as price rises)
 * - Partial exit: sell 50% at 2:1 reward (5% gain), let rest ride
 * - Max hold: 5 trading days
 * - Daily loss limit: -5% of account stops all trading ("a little aggressive")
 *
 * NOTE: per-trade sizing for the live engine now flows through lib/sleeves.ts
 * (budget × sleeve risk). calculatePositionSize() remains the baseline/fallback
 * and the single place RISK_PCT is defined.
 */

import type { Position } from './schwab'

// ── Constants ─────────────────────────────────────────────────────────────────

export const RISK_PCT         = 0.015   // 1.5% equity per trade (baseline)
export const INITIAL_STOP_PCT = 0.025   // 2.5% below entry
export const TRAIL_PCT        = 0.05    // 5% trailing from peak
export const PARTIAL_EXIT_RR  = 2.0     // Take partial at 2:1 reward:risk = 5%
export const MAX_POSITIONS    = 3
export const MAX_HOLD_DAYS    = 5
export const DAILY_LOSS_PCT   = 0.05    // -5% daily hard stop (code == docs)

// ── Position Sizing ───────────────────────────────────────────────────────────

export interface PositionSizing {
  qty: number
  risk_dollars: number
  initial_stop: number
  target_price: number   // 2:1 reward = 5%
  max_loss: number       // dollars at risk
}

export function calculatePositionSize(
  equity: number,
  entry_price: number,
  stop_pct = INITIAL_STOP_PCT,
  risk_pct  = RISK_PCT,
  exposure_cap = 0.25    // 25% live, 30% paper (passed by caller)
): PositionSizing {
  const risk_dollars  = equity * risk_pct
  const stop_distance = entry_price * stop_pct
  const stop_qty      = stop_distance > 0 ? Math.floor(risk_dollars / stop_distance) : 1

  // Capital exposure cap per position
  const max_exposure_qty = entry_price > 0 ? Math.floor((equity * exposure_cap) / entry_price) : 999
  const qty = Math.max(1, Math.min(stop_qty, max_exposure_qty))

  const initial_stop = entry_price * (1 - stop_pct)
  const target_price = entry_price * (1 + stop_pct * PARTIAL_EXIT_RR)

  return {
    qty,
    risk_dollars: Math.round(risk_dollars * 100) / 100,
    initial_stop: Math.round(initial_stop * 100) / 100,
    target_price: Math.round(target_price * 100) / 100,
    max_loss: Math.round(qty * stop_distance * 100) / 100,
  }
}

// ── Exit Decision ─────────────────────────────────────────────────────────────

export interface ExitDecision {
  should_exit: boolean
  exit_type: 'NONE' | 'INITIAL_STOP' | 'TRAILING_STOP' | 'TIME_STOP' | 'TARGET'
  reason: string
  new_peak_price: number
  trailing_stop_price: number
  pnl_pct: number
}

export function checkExitCondition(
  current_price: number,
  entry_price: number,
  peak_price: number,
  initial_stop_price: number,
  hold_days: number,
  partial_exit_done: boolean,
  trail_pct  = TRAIL_PCT,
  max_hold   = MAX_HOLD_DAYS,
  is_paper   = false
): ExitDecision {
  const new_peak  = Math.max(peak_price, current_price)
  const pnl_pct   = ((current_price - entry_price) / entry_price) * 100
  const in_profit = pnl_pct >= 1.0  // 1%+ up = in profit territory

  // ── Hard loss cap ─────────────────────────────────────────────────────────
  // Paper: 10% max loss. Live: 5% max loss. Never let it go past this.
  const hard_stop_pct = is_paper ? -10 : -5
  if (pnl_pct <= hard_stop_pct) {
    return {
      should_exit: true,
      exit_type: 'INITIAL_STOP',
      reason: `HARD STOP ${pnl_pct.toFixed(1)}% — max loss (${hard_stop_pct}%) hit`,
      new_peak_price: new_peak,
      trailing_stop_price: current_price,
      pnl_pct,
    }
  }

  // ── Initial stop (before profit) ─────────────────────────────────────────
  if (!in_profit && current_price <= initial_stop_price) {
    return {
      should_exit: true,
      exit_type: 'INITIAL_STOP',
      reason: `STOP: ${pnl_pct.toFixed(1)}% (stop $${initial_stop_price.toFixed(2)} hit)`,
      new_peak_price: new_peak,
      trailing_stop_price: initial_stop_price,
      pnl_pct,
    }
  }

  // ── Trailing stop (once in profit) ───────────────────────────────────────
  // Once up 5%+, lock in at least breakeven (stop rises to entry)
  // Once up 10%+, stop rises to +5% (never give back more than half the gain)
  let trailing_stop = new_peak * (1 - trail_pct)
  if (new_peak >= entry_price * 1.10) {
    // Lock in at least +5% once peaked at +10%
    trailing_stop = Math.max(trailing_stop, entry_price * 1.05)
  } else if (new_peak >= entry_price * 1.05) {
    // Lock in at least breakeven once peaked at +5%
    trailing_stop = Math.max(trailing_stop, entry_price * 1.001)
  }

  if (in_profit && current_price <= trailing_stop) {
    return {
      should_exit: true,
      exit_type: 'TRAILING_STOP',
      reason: `TRAIL: peaked +${(((new_peak - entry_price) / entry_price) * 100).toFixed(1)}% → trail $${trailing_stop.toFixed(2)} → now ${pnl_pct.toFixed(1)}%`,
      new_peak_price: new_peak,
      trailing_stop_price: trailing_stop,
      pnl_pct,
    }
  }

  // ── Time stop — only cut losers (profitable positions always ride) ────────
  if (hold_days >= max_hold && pnl_pct < 0) {
    return {
      should_exit: true,
      exit_type: 'TIME_STOP',
      reason: `TIME STOP: losing ${pnl_pct.toFixed(1)}% after ${hold_days}d — cut the loser`,
      new_peak_price: new_peak,
      trailing_stop_price: trailing_stop,
      pnl_pct,
    }
  }

  return {
    should_exit: false,
    exit_type: 'NONE',
    reason: `HOLD ${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(1)}% | peak +${(((new_peak - entry_price) / entry_price) * 100).toFixed(1)}% | trail $${trailing_stop.toFixed(2)}`,
    new_peak_price: new_peak,
    trailing_stop_price: trailing_stop,
    pnl_pct,
  }
}

// Should we take partial profit? (sell 50% at 2:1 reward)
export function shouldTakePartial(
  current_price: number,
  entry_price: number,
  target_price: number,
  partial_exit_done: boolean
): boolean {
  return !partial_exit_done && current_price >= target_price
}

// ── Market Hours ──────────────────────────────────────────────────────────────

export function isMarketOpen(): boolean {
  try {
    // Convert to ET time reliably
    const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
    const etDate = new Date(etStr)
    const day     = etDate.getDay()   // 0=Sun, 6=Sat
    const hours   = etDate.getHours()
    const minutes = etDate.getMinutes()

    if (day === 0 || day === 6) return false

    const mins = hours * 60 + minutes
    return mins >= 9 * 60 + 30 && mins < 16 * 60  // 9:30 AM – 4:00 PM ET
  } catch {
    return false
  }
}

export function isMarketOpenET(etHours: number, etMinutes: number, weekday: number): boolean {
  if (weekday === 0 || weekday === 6) return false
  const mins = etHours * 60 + etMinutes
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

export function getETHour(): number {
  const etStr  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  return new Date(etStr).getHours()
}

export function isNearClose(): boolean {
  const etStr  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const etDate = new Date(etStr)
  const mins   = etDate.getHours() * 60 + etDate.getMinutes()
  return mins >= 15 * 60 + 30 && mins < 16 * 60  // 3:30-4:00 PM
}

// ── Daily Loss Guard ──────────────────────────────────────────────────────────

export function isDailyLossExceeded(daily_pnl: number, balance: number): boolean {
  if (balance === 0) return false
  return (daily_pnl / balance) <= -DAILY_LOSS_PCT
}

// ── Convenience ───────────────────────────────────────────────────────────────

export function getPositionSize(balance: number, price: number, size_pct: number): number {
  const dollars = balance * size_pct
  return Math.max(1, Math.floor(dollars / price))
}

/**
 * Exposure cap (% of equity per position) scaled by signal confidence.
 * High conviction = bigger bet. Below 70 shouldn't reach here (filtered upstream).
 *
 *  90–100%  →  20%  (strong conviction, boost)
 *  80–89%   →  15%  (standard)
 *  70–79%   →  10%  (softer signal, half-size)
 *  < 70     →   7%  (barely qualifies — tiny starter)
 */
export function exposureCapForConfidence(confidence: number): number {
  if (confidence >= 90) return 0.20
  if (confidence >= 80) return 0.15
  if (confidence >= 70) return 0.10
  return 0.07
}
