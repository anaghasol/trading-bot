/**
 * Risk management rules.
 * Max 5% daily loss hard stop. Trailing stop protects profits.
 */
import { type Position } from './schwab'

export const STOP_LOSS_PCT   = -5.0  // Hard stop
export const MAX_DAILY_LOSS  = -5.0  // Stop all trading for the day
export const MAX_POSITIONS   =  3    // Max concurrent positions
export const POSITION_SIZE   =  0.15 // 15% of balance per trade (reduced in CAUTION)

interface ExitDecision {
  shouldExit: boolean
  reason: string
  updatedPeakPnl: number
}

export function checkExitCondition(
  position: Position,
  storedPeakPnl: number
): ExitDecision {
  const pnl_pct = position.pnl_pct
  const peak = Math.max(storedPeakPnl, pnl_pct)

  // Hard stop loss — no exceptions
  if (pnl_pct <= STOP_LOSS_PCT) {
    return {
      shouldExit: true,
      reason: `STOP LOSS ${pnl_pct.toFixed(1)}%`,
      updatedPeakPnl: peak,
    }
  }

  // Trailing stop — tightens as gains grow
  let trailPct: number | null = null
  if (peak >= 10.0)     trailPct = 1.5
  else if (peak >= 5.0) trailPct = 2.5
  else if (peak >= 3.0) trailPct = 3.5

  if (trailPct !== null && pnl_pct <= peak - trailPct) {
    return {
      shouldExit: true,
      reason: `TRAILING STOP (peak ${peak.toFixed(1)}% → now ${pnl_pct.toFixed(1)}%, trail ${trailPct}%)`,
      updatedPeakPnl: peak,
    }
  }

  return {
    shouldExit: false,
    reason: `HOLD ${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(1)}% (peak ${peak.toFixed(1)}%)`,
    updatedPeakPnl: peak,
  }
}

export function isDailyLossExceeded(dailyPnl: number, balance: number): boolean {
  if (balance === 0) return false
  const dailyLossPct = (dailyPnl / balance) * 100
  return dailyLossPct <= MAX_DAILY_LOSS
}

export function isMarketOpen(): boolean {
  const now = new Date()
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now)

  const weekday = et.find((p) => p.type === 'weekday')?.value
  const hour = parseInt(et.find((p) => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(et.find((p) => p.type === 'minute')?.value || '0', 10)

  if (weekday === 'Sat' || weekday === 'Sun') return false

  const minutesSinceMidnight = hour * 60 + minute
  const marketOpen  = 9 * 60 + 30   // 9:30 AM ET
  const marketClose = 16 * 60        // 4:00 PM ET

  return minutesSinceMidnight >= marketOpen && minutesSinceMidnight < marketClose
}

export function isNearClose(): boolean {
  const now = new Date()
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)

  const hour = parseInt(et.find((p) => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(et.find((p) => p.type === 'minute')?.value || '0', 10)

  // Within 20 minutes of close (3:40 PM ET)
  const minutesSinceMidnight = hour * 60 + minute
  const closeWindow = 15 * 60 + 40
  return minutesSinceMidnight >= closeWindow
}

export function getPositionSize(balance: number, price: number, sizePct: number): number {
  const dollars = balance * sizePct
  return Math.max(1, Math.floor(dollars / price))
}
