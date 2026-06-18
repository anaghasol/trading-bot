import { evaluateOptionsExit, isOccSymbol, parseOccSymbol } from '../lib/options-exit'

// Fixed "now" so expiry-based tests are deterministic
const NOW = new Date('2026-06-18T14:00:00Z').getTime()
const future30d = '2026-07-18'  // 30 days out — safe
const future1d  = '2026-06-19'  // 1 day out — triggers EXPIRY_PROTECTION
const past      = '2026-06-17'  // already expired

describe('evaluateOptionsExit', () => {
  // ── Short position (qty < 0) ──────────────────────────────────────────────
  it('immediately closes a naked short (qty < 0), regardless of P&L', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260724P00485000', quantity: -5, pnl_pct: 10, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('SHORT_OPT_CLEANUP')
  })

  it('short close takes priority even when profit is high', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260724C00500000', quantity: -1, pnl_pct: 200, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('SHORT_OPT_CLEANUP')
  })

  // ── Stop loss ─────────────────────────────────────────────────────────────
  it('triggers OPT_STOP at exactly -25%', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260724P00485000', quantity: 3, pnl_pct: -25, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('OPT_STOP')
  })

  it('triggers OPT_STOP below -25%', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260724P00485000', quantity: 3, pnl_pct: -40, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('OPT_STOP')
  })

  it('holds at -24.9% (not yet at stop)', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260724P00485000', quantity: 3, pnl_pct: -24.9, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('HOLD')
  })

  // ── Full target ───────────────────────────────────────────────────────────
  it('triggers OPT_TARGET at exactly +100%', () => {
    const result = evaluateOptionsExit(
      { symbol: 'COIN260724C00300000', quantity: 2, pnl_pct: 100, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('OPT_TARGET')
  })

  it('triggers OPT_TARGET above +100%', () => {
    const result = evaluateOptionsExit(
      { symbol: 'COIN260724C00300000', quantity: 2, pnl_pct: 150, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('OPT_TARGET')
  })

  it('holds at +99% (not yet at full target)', () => {
    const result = evaluateOptionsExit(
      { symbol: 'COIN260724C00300000', quantity: 2, pnl_pct: 99, option_expiry: future30d },
      false, NOW
    )
    // Should trigger partial at +80% if partial not done
    expect(result.action).toBe('PARTIAL_CLOSE')
    expect(result.reason).toBe('PARTIAL_1')
  })

  // ── Partial exit ──────────────────────────────────────────────────────────
  it('triggers PARTIAL_CLOSE at +80%', () => {
    const result = evaluateOptionsExit(
      { symbol: 'NVDA260815C00900000', quantity: 4, pnl_pct: 80, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('PARTIAL_CLOSE')
    expect(result.reason).toBe('PARTIAL_1')
    expect(result.partialQty).toBe(2)  // floor(4 * 0.5)
  })

  it('PARTIAL_CLOSE qty is at least 1 for single-contract positions', () => {
    const result = evaluateOptionsExit(
      { symbol: 'NVDA260815C00900000', quantity: 1, pnl_pct: 85, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('PARTIAL_CLOSE')
    expect(result.partialQty).toBe(1)
  })

  it('skips partial if already done', () => {
    const result = evaluateOptionsExit(
      { symbol: 'NVDA260815C00900000', quantity: 2, pnl_pct: 85, option_expiry: future30d },
      true, NOW  // partial already done
    )
    expect(result.action).toBe('HOLD')
  })

  it('holds at +79% (partial not triggered yet)', () => {
    const result = evaluateOptionsExit(
      { symbol: 'NVDA260815C00900000', quantity: 4, pnl_pct: 79, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('HOLD')
  })

  // ── Expiry protection ─────────────────────────────────────────────────────
  it('closes when DTE is 1 day', () => {
    const result = evaluateOptionsExit(
      { symbol: 'TSLA260619P00200000', quantity: 2, pnl_pct: -5, option_expiry: future1d },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('EXPIRY_PROTECTION')
  })

  it('closes for past expiry', () => {
    const result = evaluateOptionsExit(
      { symbol: 'TSLA260617P00200000', quantity: 2, pnl_pct: -10, option_expiry: past },
      false, NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('EXPIRY_PROTECTION')
  })

  it('holds when no expiry is set (defaults to 999 DTE)', () => {
    const result = evaluateOptionsExit(
      { symbol: 'TSLA260619P00200000', quantity: 2, pnl_pct: -5 },
      false, NOW
    )
    expect(result.action).toBe('HOLD')
  })

  // ── Normal hold ───────────────────────────────────────────────────────────
  it('holds a healthy position in the middle zone', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260724P00485000', quantity: 3, pnl_pct: 15, option_expiry: future30d },
      false, NOW
    )
    expect(result.action).toBe('HOLD')
    expect(result.reason).toBeNull()
  })
})

// ── OCC symbol detection ───────────────────────────────────────────────────
describe('isOccSymbol', () => {
  it('recognises valid OCC symbols', () => {
    expect(isOccSymbol('AMD260724P00485000')).toBe(true)
    expect(isOccSymbol('NVDA260815C00900000')).toBe(true)
    expect(isOccSymbol('TSLA260619P00200000')).toBe(true)
    expect(isOccSymbol('SPY260718C00520000')).toBe(true)
    expect(isOccSymbol('A260101C00010000')).toBe(true)   // single-char ticker
  })

  it('rejects plain stock symbols', () => {
    expect(isOccSymbol('AMD')).toBe(false)
    expect(isOccSymbol('COIN')).toBe(false)
    expect(isOccSymbol('AAPL')).toBe(false)
  })

  it('rejects malformed OCC symbols', () => {
    expect(isOccSymbol('AMD260724X00485000')).toBe(false)   // X not C or P
    expect(isOccSymbol('AMD26724P00485000')).toBe(false)    // only 5 date digits
    expect(isOccSymbol('AMD260724P0048500')).toBe(false)    // only 7 strike digits
    expect(isOccSymbol('')).toBe(false)
  })
})

// ── OCC symbol parsing ─────────────────────────────────────────────────────
describe('parseOccSymbol', () => {
  it('parses AMD put correctly', () => {
    const result = parseOccSymbol('AMD260724P00485000')
    expect(result).toEqual({ ticker: 'AMD', expiry: '2026-07-24', type: 'PUT', strike: 485 })
  })

  it('parses NVDA call correctly', () => {
    const result = parseOccSymbol('NVDA260815C00900000')
    expect(result).toEqual({ ticker: 'NVDA', expiry: '2026-08-15', type: 'CALL', strike: 900 })
  })

  it('returns null for non-OCC symbol', () => {
    expect(parseOccSymbol('AMD')).toBeNull()
  })

  it('handles fractional strikes ($12.50 = 00012500)', () => {
    const result = parseOccSymbol('GME260101C00012500')
    expect(result?.strike).toBe(12.5)
  })
})
