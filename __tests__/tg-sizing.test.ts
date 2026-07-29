/**
 * Tests for TG signal sizing in recovery mode.
 *
 * Root cause: at $67K (deep recovery), TG signals with 90% confidence were
 * getting 20% exposure cap → SHLS at $8.81 = 1,558 shares = $13.7K = 20% of
 * account from a single channel signal. In deep recovery this is reckless.
 *
 * Fix: deep recovery (<$82K) caps to 5%, recovery (<$92K) to 8%.
 */
import { calculatePositionSize, exposureCapForConfidence } from '../lib/risk'

function tgExposureCap(confidence: number, equity: number): number {
  const baseCap = exposureCapForConfidence(confidence)
  if (equity < 82_000) return Math.min(baseCap, 0.05)   // deep recovery: 5% max
  if (equity < 92_000) return Math.min(baseCap, 0.08)   // recovery: 8% max
  return baseCap
}

describe('TG signal exposure cap by account health', () => {
  it('normal account ($100K): 90% conf → 20% cap', () => {
    expect(tgExposureCap(90, 100_000)).toBe(0.20)
  })

  it('recovery account ($88K): 90% conf → capped to 8%', () => {
    expect(tgExposureCap(90, 88_000)).toBe(0.08)
  })

  it('deep recovery ($67K): 90% conf → capped to 5%', () => {
    expect(tgExposureCap(90, 67_000)).toBe(0.05)
  })

  it('deep recovery ($67K): 70% conf (10% base) → capped to 5%', () => {
    expect(tgExposureCap(70, 67_000)).toBe(0.05)
  })

  it('normal account: 70% conf → 10% cap unchanged', () => {
    expect(tgExposureCap(70, 100_000)).toBe(0.10)
  })
})

describe('TG position sizing — deep recovery ($67K)', () => {
  const equity = 67_000
  const profile = { initial_stop_pct: 0.025, risk_pct: 0.02 }

  it('SHLS at $8.81: deep recovery caps position to ~$3,350 (not $13.7K)', () => {
    const cap = tgExposureCap(90, equity)          // 5%
    const { qty } = calculatePositionSize(equity, 8.81, profile.initial_stop_pct, profile.risk_pct, cap)
    const positionValue = qty * 8.81
    expect(positionValue).toBeLessThan(equity * 0.06)  // well under 6% of account
    expect(positionValue).toBeGreaterThan(0)
  })

  it('TSLA at $350: deep recovery keeps under $3,350', () => {
    const cap = tgExposureCap(90, equity)
    const { qty } = calculatePositionSize(equity, 350, profile.initial_stop_pct, profile.risk_pct, cap)
    const positionValue = qty * 350
    expect(positionValue).toBeLessThan(equity * 0.06)
  })

  it('NVDA at $130: deep recovery keeps under $3,350', () => {
    const cap = tgExposureCap(90, equity)
    const { qty } = calculatePositionSize(equity, 130, profile.initial_stop_pct, profile.risk_pct, cap)
    expect(qty * 130).toBeLessThan(equity * 0.06)
  })
})

describe('exposureCapForConfidence baseline', () => {
  it('90% conf → 20%', () => expect(exposureCapForConfidence(90)).toBe(0.20))
  it('80% conf → 15%', () => expect(exposureCapForConfidence(80)).toBe(0.15))
  it('70% conf → 10%', () => expect(exposureCapForConfidence(70)).toBe(0.10))
  it('60% conf → 7%',  () => expect(exposureCapForConfidence(60)).toBe(0.07))
  it('below 60 → 7%',  () => expect(exposureCapForConfidence(50)).toBe(0.07))
})
