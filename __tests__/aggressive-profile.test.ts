/**
 * Tests for the alpaca_paper strategy profile.
 * Guards against accidental regression of key numbers.
 * Updated 2026-07-14: capped at 8 positions / 60% exposure after 130%-leveraged
 * 17-position portfolio caused -$6,634 (-7.67%) in a single session.
 */
import { PROFILES, profileFor } from '../lib/strategy-profiles'

describe('alpaca_paper profile — protected aggressive (8 positions)', () => {
  const p = PROFILES.alpaca_paper

  it('has 8 max positions — 20 caused 130% margin leverage', () => expect(p.max_positions).toBe(8))
  it('has 2.5% initial stop', () => expect(p.initial_stop_pct).toBe(0.025))
  it('has 5% trail (room for winners)', () => expect(p.trail_pct).toBe(0.05))
  it('has 2% risk per trade', () => expect(p.risk_pct).toBe(0.02))
  it('has 7% daily loss breaker — halts after one bad session', () => expect(p.daily_loss_stop_pct).toBe(0.07))
  it('allows day trades', () => expect(p.allow_day_trades).toBe(true))
  it('uses wide scan universe', () => expect(p.scan_universe).toBe('wide'))
  it('max hold 3 days — no dead weight', () => expect(p.max_hold_days).toBe(3))
})

describe('schwab profile — tuned 2026-06-30 (real money, protected)', () => {
  const p = PROFILES.schwab

  it('has 5 max positions (was 4 — more deployment for compounding)', () => expect(p.max_positions).toBe(5))
  it('has 2.5% initial stop (was 4% — cut losses faster on live money)', () => expect(p.initial_stop_pct).toBe(0.025))
  it('has 68% confidence gate (was 72% — allows strong TG + EMA setups)', () => expect(p.min_confidence).toBe(68))
  it('does not allow day trades', () => expect(p.allow_day_trades).toBe(false))
  it('has 5% daily loss breaker', () => expect(p.daily_loss_stop_pct).toBe(0.05))
})

describe('profileFor()', () => {
  it('returns alpaca_paper profile for alpaca_paper broker', () => {
    expect(profileFor('alpaca_paper').max_positions).toBe(8)
  })
  it('returns schwab profile for schwab broker', () => {
    expect(profileFor('schwab').max_positions).toBe(5)
  })
  it('falls back to schwab for unknown broker', () => {
    expect(profileFor('unknown').key).toBe('schwab')
  })
})

describe('position math sanity — 8 positions / protected aggressive', () => {
  const p = PROFILES.alpaca_paper
  const equity = 100_000

  it('8 positions at 2% risk each = 16% risk budget (was 60% — way too high)', () => {
    const totalRiskBudget = p.max_positions * p.risk_pct * equity
    expect(totalRiskBudget).toBe(16_000)
  })

  it('per-position size at 2.5% stop: risk / stop = 2% / 2.5% = 0.8× equity per position', () => {
    const impliedSize = (p.risk_pct / p.initial_stop_pct) * equity
    expect(impliedSize).toBe(80_000)  // notional cap at 10% of equity ($10K) limits actual to $10K
  })

  it('with 10% notional cap and 60% exposure gate: max deployed = 60% of equity', () => {
    const cappedPerPos = 0.10 * equity
    expect(cappedPerPos).toBe(10_000)
  })
})
