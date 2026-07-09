/**
 * Pure functions for options position exit decisions.
 * Extracted here so they can be unit-tested without spinning up Next.js routes.
 */

export interface OptionsPosition {
  symbol: string
  quantity: number          // negative = short leg of a spread OR naked short
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
 *
 * @param stopLossPct    Max allowed premium loss. Default -25%; pass -10 for aggressive paper.
 * @param allOptPositions All open options positions — used to detect if a short is a spread leg.
 *                        A short put that has a matching long put (same expiry, lower strike)
 *                        is the short leg of a bull put spread → must NOT be closed as naked short.
 */
export function evaluateOptionsExit(
  pos: OptionsPosition,
  partialAlreadyDone: boolean,
  nowMs = Date.now(),
  stopLossPct = -25,
  allOptPositions: OptionsPosition[] = []
): OptionsExitDecision {
  const premPct = pos.pnl_pct
  const expiry = pos.option_expiry
  const dteDays = expiry
    ? (new Date(expiry).getTime() - nowMs) / 86_400_000
    : 999

  // Short position — only close immediately if it's NAKED (no matching long leg below it)
  if (pos.quantity < 0) {
    const isSpreadShortLeg = isPartOfSpread(pos.symbol, allOptPositions)
    if (!isSpreadShortLeg) {
      return { action: 'FULL_CLOSE', reason: 'SHORT_OPT_CLEANUP' }
    }
    // It's the short leg of a spread — manage by expiry and profit, not immediate cleanup
    if (dteDays <= 2)  return { action: 'FULL_CLOSE', reason: 'EXPIRY_PROTECTION' }
    // Spread profit: when short premium has decayed 50% → buy back
    if (premPct <= -50) return { action: 'FULL_CLOSE', reason: 'OPT_TARGET' }   // neg pnl on short = our gain
    if (premPct >= 50)  return { action: 'FULL_CLOSE', reason: 'OPT_STOP' }    // pos pnl on short = our loss
    return { action: 'HOLD', reason: null }
  }

  // Near-expiry protection: close 2 days before expiry
  if (dteDays <= 2) {
    return { action: 'FULL_CLOSE', reason: 'EXPIRY_PROTECTION' }
  }

  // Stop loss: premium down past stopLossPct (-10% paper, -25% live)
  if (premPct <= stopLossPct) {
    return { action: 'FULL_CLOSE', reason: 'OPT_STOP' }
  }

  // Full target: premium up ≥50% — standard options management rule
  if (premPct >= 50) {
    return { action: 'FULL_CLOSE', reason: 'OPT_TARGET' }
  }

  // Partial exit at +30% — lock half the position, let rest run
  if (premPct >= 30 && !partialAlreadyDone) {
    const partialQty = Math.max(1, Math.floor(Math.abs(pos.quantity) * 0.5))
    return { action: 'PARTIAL_CLOSE', reason: 'PARTIAL_1', partialQty }
  }

  return { action: 'HOLD', reason: null }
}

/**
 * Returns true if a short options position is the short leg of a spread —
 * i.e., there's a long position in the same underlying, same expiry, lower/same strike.
 *
 * Example: short CRWD260724P00700000 + long CRWD260724P00690000 → spread, don't close naked.
 */
export function isPartOfSpread(shortSymbol: string, allPositions: OptionsPosition[]): boolean {
  const shortParsed = parseOccSymbol(shortSymbol)
  if (!shortParsed) return false
  return allPositions.some((p) => {
    if (p.quantity <= 0) return false     // must be a LONG leg
    const lp = parseOccSymbol(p.symbol)
    if (!lp) return false
    return (
      lp.ticker === shortParsed.ticker &&
      lp.expiry === shortParsed.expiry &&
      lp.type   === shortParsed.type   &&
      lp.strike < shortParsed.strike    // long put below short put = bull put spread
    )
  })
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
