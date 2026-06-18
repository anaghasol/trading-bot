/**
 * Tests for orphan naked short detection.
 * Simulates the AMD $500P qty=-7 scenario that wasn't being auto-closed
 * because the accidental short had no journal entry in tb_trades.
 */
import { evaluateOptionsExit } from '../lib/options-exit'

describe('orphan naked short detection', () => {
  const NOW = new Date('2026-06-18T14:00:00Z').getTime()

  it('flags a negative-qty options position for cleanup even at small loss', () => {
    // This simulates the AMD $500P qty=-7 case: -13.45% on the position
    const result = evaluateOptionsExit(
      { symbol: 'AMD260710P00500000', quantity: -7, pnl_pct: -13.45, option_expiry: '2026-07-10' },
      false,
      NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('SHORT_OPT_CLEANUP')
  })

  it('flags a negative-qty options position even when profitable (never hold shorts)', () => {
    const result = evaluateOptionsExit(
      { symbol: 'NVDA260815C00900000', quantity: -2, pnl_pct: 50, option_expiry: '2026-08-15' },
      false,
      NOW
    )
    expect(result.action).toBe('FULL_CLOSE')
    expect(result.reason).toBe('SHORT_OPT_CLEANUP')
  })

  it('does NOT flag a normal long position as a short', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260710P00495000', quantity: 7, pnl_pct: -0.75, option_expiry: '2026-07-10' },
      false,
      NOW
    )
    // -0.75% is well within the -25% stop — should hold
    expect(result.action).toBe('HOLD')
  })

  it('does NOT flag qty=0 as a short (closed position)', () => {
    const result = evaluateOptionsExit(
      { symbol: 'AMD260710P00500000', quantity: 0, pnl_pct: -13, option_expiry: '2026-07-10' },
      false,
      NOW
    )
    // qty=0 means position is already closed — not a short
    expect(result.action).not.toBe('FULL_CLOSE')
  })
})
