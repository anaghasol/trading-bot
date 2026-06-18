/**
 * Pure functions for options position exit decisions.
 * Extracted here so they can be unit-tested without spinning up Next.js routes.
 */

export interface OptionsPosition {
  symbol: string
  quantity: number          // negative = short (MUST close immediately)
  pnl_pct: number           // % gain/loss on premium paid
  option_expiry?: string    // YYYY-MM-DD
}

export type OptionsExitReason =
  | 'SHORT_OPT_CLEANUP'
  | 'EXPIRY_PROTECTION'
  | 'OPT_STOP'
  | 'OPT_TARGET'
  | 'PARTIAL_1'
  | null

export interface OptionsExitDecision {
  action: 'FULL_CLOSE' | 'PARTIAL_CLOSE' | 'HOLD'
  reason: OptionsExitReason
  partialQty?: number
}

/**
 * Determine what to do with an options position this monitor cycle.
 * Returns FULL_CLOSE, PARTIAL_CLOSE, or HOLD.
 */
export function evaluateOptionsExit(
  pos: OptionsPosition,
  partialAlreadyDone: boolean,
  nowMs = Date.now()
): OptionsExitDecision {
  const premPct = pos.pnl_pct
  const expiry = pos.option_expiry
  const dteDays = expiry
    ? (new Date(expiry).getTime() - nowMs) / 86_400_000
    : 999

  // Short options must never be held — close immediately
  if (pos.quantity < 0) {
    return { action: 'FULL_CLOSE', reason: 'SHORT_OPT_CLEANUP' }
  }

  // Near-expiry protection: close 2 days before expiry
  if (dteDays <= 2) {
    return { action: 'FULL_CLOSE', reason: 'EXPIRY_PROTECTION' }
  }

  // Stop loss: premium down ≥25%
  if (premPct <= -25) {
    return { action: 'FULL_CLOSE', reason: 'OPT_STOP' }
  }

  // Full target: premium up ≥100%
  if (premPct >= 100) {
    return { action: 'FULL_CLOSE', reason: 'OPT_TARGET' }
  }

  // Partial exit at +80% (only once)
  if (premPct >= 80 && !partialAlreadyDone) {
    const partialQty = Math.max(1, Math.floor(Math.abs(pos.quantity) * 0.5))
    return { action: 'PARTIAL_CLOSE', reason: 'PARTIAL_1', partialQty }
  }

  return { action: 'HOLD', reason: null }
}

/** Detect whether a symbol is an OCC options symbol */
export const OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/

export function isOccSymbol(symbol: string): boolean {
  return OCC_RE.test(symbol)
}

/** Parse OCC symbol into human-readable parts (for logging / TG messages) */
export function parseOccSymbol(symbol: string): {
  ticker: string
  expiry: string        // YYYY-MM-DD
  type: 'CALL' | 'PUT'
  strike: number
} | null {
  if (!isOccSymbol(symbol)) return null
  const m = symbol.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
  if (!m) return null
  const [, ticker, yy, mm, dd, cp, strikeRaw] = m
  return {
    ticker,
    expiry: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'CALL' : 'PUT',
    strike: parseInt(strikeRaw, 10) / 1000,
  }
}
