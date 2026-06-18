/**
 * Tests for checkExitCondition — guards the exact thresholds that caused
 * COIN to be held at -4.99% when it should have been cut at -2%.
 */
import { checkExitCondition } from '../lib/risk'

const ENTRY = 172.74

describe('hard stop (paper = -5%)', () => {
  it('triggers hard stop at exactly -5%', () => {
    const price = ENTRY * 0.95  // exactly -5%
    const result = checkExitCondition(price, ENTRY, ENTRY, ENTRY * 0.98, 1, false, 0.04, 3, true)
    expect(result.should_exit).toBe(true)
    expect(result.exit_type).toBe('INITIAL_STOP')
  })

  it('triggers hard stop below -5%', () => {
    const price = ENTRY * 0.93  // -7%
    const result = checkExitCondition(price, ENTRY, ENTRY, ENTRY * 0.98, 1, false, 0.04, 3, true)
    expect(result.should_exit).toBe(true)
  })

  it('does NOT trigger hard stop at -4.9%', () => {
    const price = ENTRY * 0.951  // just above -5%
    const result = checkExitCondition(price, ENTRY, ENTRY, ENTRY * 0.98, 1, false, 0.04, 3, true)
    // hard stop not triggered — but initial stop (2% profile) should still catch it
    // because price ($164.33) < initial_stop ($169.29 = entry × 0.98)
    expect(result.should_exit).toBe(true)
    expect(result.exit_type).toBe('INITIAL_STOP')
  })
})

describe('initial stop uses TIGHTER of profile vs sleeve', () => {
  // COIN scenario: entered under old 5% sleeve stop ($164.10), profile now 2% ($169.29)
  // The monitor now uses Math.max(profileStop, recordedStop) = Math.max($169.29, $164.10) = $169.29
  // At $164.13, COIN is below $169.29 → should exit

  it('profile 2% stop ($169.29) catches COIN at $164.13', () => {
    const profileStop = ENTRY * 0.98   // $169.29 — 2% profile
    const result = checkExitCondition(164.13, ENTRY, ENTRY, profileStop, 1, false, 0.04, 3, true)
    expect(result.should_exit).toBe(true)
    expect(result.exit_type).toBe('INITIAL_STOP')
  })

  it('old 5% sleeve stop ($164.10) would NOT catch COIN at $164.13', () => {
    const sleeveStop = ENTRY * 0.95    // $164.10 — 5% sleeve
    const result = checkExitCondition(164.13, ENTRY, ENTRY, sleeveStop, 1, false, 0.04, 3, true)
    // $164.13 > $164.10 → initial stop check fails — but hard stop at -5% catches it
    // because -4.99% < -5% is FALSE (borderline) — this is the bug that let it slide
    // With new hard stop = -5%: -4.99% is NOT below -5%, so hard stop doesn't trigger either
    // The old behavior: HOLD. The new behavior: use profile stop = caught.
    expect(result.should_exit).toBe(false)  // proves the bug: sleeve stop alone doesn't catch it
  })
})

describe('initial stop — general cases', () => {
  it('stops out at 2% below entry', () => {
    const stop = ENTRY * 0.98
    const price = ENTRY * 0.979  // just below stop
    const result = checkExitCondition(price, ENTRY, ENTRY, stop, 1, false, 0.04, 3, true)
    expect(result.should_exit).toBe(true)
    expect(result.exit_type).toBe('INITIAL_STOP')
  })

  it('holds at 1.9% below entry (above 2% stop)', () => {
    const stop = ENTRY * 0.98
    const price = ENTRY * 0.981  // above stop
    const result = checkExitCondition(price, ENTRY, ENTRY, stop, 1, false, 0.04, 3, true)
    expect(result.should_exit).toBe(false)
  })

  it('does NOT trigger initial stop when in profit (uses trailing instead)', () => {
    const stop = ENTRY * 0.98
    const price = ENTRY * 1.02   // in profit
    const result = checkExitCondition(price, ENTRY, price, stop, 1, false, 0.04, 3, true)
    expect(result.should_exit).toBe(false)
    expect(result.exit_type).toBe('NONE')
  })
})

describe('time stop — losers cut after max hold days', () => {
  it('cuts a loser after 3 days (new max_hold_days for paper)', () => {
    const stop = ENTRY * 0.98
    const price = ENTRY * 0.99  // -1%, above stop
    const result = checkExitCondition(price, ENTRY, ENTRY, stop, 3, false, 0.04, 3, true)
    expect(result.should_exit).toBe(true)
    expect(result.exit_type).toBe('TIME_STOP')
  })

  it('does NOT cut a WINNER after max hold days (let winners run)', () => {
    const stop = ENTRY * 0.98
    const price = ENTRY * 1.08  // +8%, in profit
    const result = checkExitCondition(price, ENTRY, price, stop, 10, false, 0.04, 3, true)
    expect(result.should_exit).toBe(false)
  })
})

describe('trailing stop protects gains', () => {
  it('triggers trailing stop when pulling back from peak', () => {
    const peak  = ENTRY * 1.12  // was up 12%
    const price = ENTRY * 1.07  // now +7% — pulled back from 12%
    const stop  = ENTRY * 0.98
    // At 12% peak: breakeven floor kicks in at entry*1.05 = +5%. trailing_stop = peak*(1-0.04) = $172.74*1.12*0.96
    const result = checkExitCondition(price, ENTRY, peak, stop, 1, false, 0.04, 3, true)
    // peak*(1-0.04) = 172.74*1.12*0.96 = 185.79. price=172.74*1.07=184.83 < 185.79 → should exit
    expect(result.should_exit).toBe(true)
    expect(result.exit_type).toBe('TRAILING_STOP')
  })
})
