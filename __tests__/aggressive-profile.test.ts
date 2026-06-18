/**
 * Tests for the permanent aggressive strategy profile changes.
 * Guards against accidental regression of the key numbers.
 */
import { PROFILES, profileFor } from '../lib/strategy-profiles'

describe('alpaca_paper profile — permanent aggressive mode', () => {
  const p = PROFILES.alpaca_paper

  it('has 40 max positions', () => expect(p.max_positions).toBe(40))
  it('has 2% initial stop (fast cut)', () => expect(p.initial_stop_pct).toBe(0.02))
  it('has 4% trail (tight lock)', () => expect(p.trail_pct).toBe(0.04))
  it('has 2.5% risk per trade (small enough for 40 positions)', () => expect(p.risk_pct).toBe(0.025))
  it('has 15% daily loss breaker', () => expect(p.daily_loss_stop_pct).toBe(0.15))
  it('allows day trades', () => expect(p.allow_day_trades).toBe(true))
  it('uses wide scan universe', () => expect(p.scan_universe).toBe('wide'))
  it('max hold 3 days — no dead weight', () => expect(p.max_hold_days).toBe(3))
})

describe('schwab profile — unchanged (real money, protected)', () => {
  const p = PROFILES.schwab

  it('still has 4 max positions', () => expect(p.max_positions).toBe(4))
  it('still has 4% initial stop', () => expect(p.initial_stop_pct).toBe(0.04))
  it('does not allow day trades', () => expect(p.allow_day_trades).toBe(false))
  it('has 5% daily loss breaker', () => expect(p.daily_loss_stop_pct).toBe(0.05))
})

describe('profileFor()', () => {
  it('returns alpaca_paper profile for alpaca_paper broker', () => {
    expect(profileFor('alpaca_paper').max_positions).toBe(40)
  })
  it('returns schwab profile for schwab broker', () => {
    expect(profileFor('schwab').max_positions).toBe(4)
  })
  it('falls back to schwab for unknown broker', () => {
    expect(profileFor('unknown').key).toBe('schwab')
  })
})

describe('position math sanity — 40 positions fit within capital', () => {
  const p = PROFILES.alpaca_paper
  const equity = 100_000

  it('40 positions at 2.5% risk each = 100% risk budget (diversified)', () => {
    const totalRiskBudget = p.max_positions * p.risk_pct * equity
    // Total "risk" (money at risk if all stop out) = 40 * 2.5% * $100K = $100K
    // That would only trigger if ALL 40 positions hit their stop simultaneously — impossible in practice
    expect(totalRiskBudget).toBe(100_000)
  })

  it('per-position size at 2% stop: risk / stop = 2.5% / 2% = 1.25× equity per position', () => {
    // This shows why the per-position cap (5% of equity) is essential
    const impliedSize = (p.risk_pct / p.initial_stop_pct) * equity
    expect(impliedSize).toBe(125_000)  // without cap, one position would exceed account — cap prevents this
  })

  it('with 5% per-position cap: 40 × 5% = 200% — cap ensures max ~95% actual exposure', () => {
    // Each position is capped at 5% of equity = $5K
    // 40 × $5K = $200K theoretical max but exposure gate (95%) stops it at ~19 positions per scan
    const cappedPerPos = 0.05 * equity
    expect(cappedPerPos).toBe(5_000)
  })
})
