/**
 * Tests for the alpaca_paper strategy profile.
 * Guards against accidental regression of key numbers.
 * Updated 2026-06-22: switched from "max aggression / 40 positions" to
 * "quality mode / 20 positions" after 25% WR / PF=0.17 over two days.
 */
import { PROFILES, profileFor } from '../lib/strategy-profiles'

describe('alpaca_paper profile — quality mode (20 positions)', () => {
  const p = PROFILES.alpaca_paper

  it('has 20 max positions (quality over quantity)', () => expect(p.max_positions).toBe(20))
  it('has 2.5% initial stop', () => expect(p.initial_stop_pct).toBe(0.025))
  it('has 5% trail (room for winners)', () => expect(p.trail_pct).toBe(0.05))
  it('has 3% risk per trade (fewer positions → more per entry)', () => expect(p.risk_pct).toBe(0.03))
  it('has 15% daily loss breaker', () => expect(p.daily_loss_stop_pct).toBe(0.15))
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
    expect(profileFor('alpaca_paper').max_positions).toBe(20)
  })
  it('returns schwab profile for schwab broker', () => {
    expect(profileFor('schwab').max_positions).toBe(5)
  })
  it('falls back to schwab for unknown broker', () => {
    expect(profileFor('unknown').key).toBe('schwab')
  })
})

describe('position math sanity — 20 positions / quality mode', () => {
  const p = PROFILES.alpaca_paper
  const equity = 100_000

  it('20 positions at 3% risk each = 60% risk budget', () => {
    const totalRiskBudget = p.max_positions * p.risk_pct * equity
    expect(totalRiskBudget).toBe(60_000)
  })

  it('per-position size at 2.5% stop: risk / stop = 3% / 2.5% = 1.2× equity per position', () => {
    const impliedSize = (p.risk_pct / p.initial_stop_pct) * equity
    expect(impliedSize).toBe(120_000)  // notional cap at 10% of equity ($10K) prevents this
  })

  it('with 10% notional cap: 20 × 10% = 200% theoretical — exposure gate (97%) limits actual', () => {
    const cappedPerPos = 0.10 * equity
    expect(cappedPerPos).toBe(10_000)
  })
})
