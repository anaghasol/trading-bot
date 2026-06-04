/**
 * SLEEVES — capital split across time-horizons, and the single source of truth
 * for how the engine sizes a position once a setup is chosen.
 *
 * The UI (app/sleeves) lets you split equity into four sleeves; the split is
 * persisted in tb_context under key "sleeves" (see app/api/sleeves/route.ts).
 * The scanner reads that split here and sizes EACH entry against its sleeve's
 * budget + aggressiveness — so "a little aggressive while small, lean long as we
 * grow" is enforced by the engine, not just shown on a page.
 *
 *   setup (from ai-advisor)  →  sleeve  →  budget slice + risk% + stop + hold
 *
 * No new table, no schema change. Reuses the existing key/value context store.
 */

import type { createServiceClient } from './supabase-server'
import type { StrategyProfile } from './strategy-profiles'

export type SleeveKey = 'aggressive' | 'short' | 'little_long' | 'long'

export interface SleeveSpec {
  key: SleeveKey
  label: string
  /** fraction of THIS sleeve's budget to risk on one trade (scaled by profile) */
  risk_mult: number
  /** protective stop below entry for this horizon */
  stop_pct: number
  /** trailing stop the monitor should use (passed to placeBuyWithProtection) */
  trail_pct: number
  /** expected hold window in trading days */
  hold_days: number
  /** max share of a sleeve's budget a single position may consume */
  max_position_share: number
}

/** Aggressive = fast & hot, Long = slow & compounding. Tuned for $2K→$25K. */
export const SLEEVES: Record<SleeveKey, SleeveSpec> = {
  aggressive:  { key: 'aggressive',  label: 'Aggressive',      risk_mult: 1.6, stop_pct: 0.05, trail_pct: 5,  hold_days: 2,  max_position_share: 0.55 },
  short:       { key: 'short',       label: 'Short-term',      risk_mult: 1.2, stop_pct: 0.045, trail_pct: 5,  hold_days: 4,  max_position_share: 0.50 },
  little_long: { key: 'little_long', label: 'Little Long-term', risk_mult: 0.9, stop_pct: 0.06, trail_pct: 7,  hold_days: 12, max_position_share: 0.60 },
  long:        { key: 'long',        label: 'Long-term',       risk_mult: 0.6, stop_pct: 0.08, trail_pct: 9,  hold_days: 45, max_position_share: 0.75 },
}

export const DEFAULT_ALLOC: Record<SleeveKey, number> = { aggressive: 40, short: 30, little_long: 20, long: 10 }

/** Map an ai-advisor / scanner setup name → the sleeve that should hold it. */
export function sleeveForSetup(setup: string): SleeveKey {
  switch ((setup || '').toUpperCase()) {
    // High-velocity: scanner BREAKOUT + legacy MOMENTUM_BREAKOUT → most aggressive
    case 'BREAKOUT':
    case 'MOMENTUM_BREAKOUT': return 'aggressive'
    // Intraday momentum: short hold, tighter stop
    case 'MOMENTUM':
    case 'REVERSAL':          return 'short'
    // EMA bounces: medium-term swing
    case 'EMA20_BOUNCE':
    case 'EMA50_PULLBACK':
    case 'TREND':             return 'little_long'
    // Everything else: long sleeve (most conservative sizing)
    default:                  return 'long'
  }
}

/** Read the persisted split (percentages summing to ~100). Falls back to default. */
export async function getSleeveAllocation(
  db: ReturnType<typeof createServiceClient>
): Promise<Record<SleeveKey, number>> {
  try {
    const { data } = await db.from('tb_context').select('value').eq('key', 'sleeves').single()
    if (data?.value) {
      const parsed = JSON.parse(data.value)
      return { ...DEFAULT_ALLOC, ...parsed }
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_ALLOC }
}

export interface SleeveSizing {
  sleeve: SleeveKey
  qty: number
  stop_pct: number       // fraction below entry
  trail_pct: number      // percent for placeBuyWithProtection
  hold_days: number
  budget: number         // dollars allotted to this sleeve
  risk_dollars: number   // dollars at risk on this entry
  note: string
}

/**
 * Size ONE entry against its sleeve.
 *
 *   sleeveBudget = equity * alloc[sleeve]%            (capital this horizon owns)
 *   riskDollars  = sleeveBudget * profile.risk_pct * sleeve.risk_mult * categoryBias
 *   qty          = riskDollars / (price * stopDist)   (shares so a stop ≈ riskDollars)
 *
 * Capped so one position never exceeds `max_position_share` of its sleeve budget.
 * `categoryBias` (from rotation) tilts size toward hot themes, away from cold.
 */
export function sleeveSizing(
  sleeve: SleeveKey,
  profile: StrategyProfile,
  equity: number,
  price: number,
  alloc: Record<SleeveKey, number>,
  categoryBias = 1,
): SleeveSizing {
  const spec   = SLEEVES[sleeve]
  const totalA = Object.values(alloc).reduce((a, b) => a + b, 0) || 100
  const weight = (alloc[sleeve] ?? 0) / totalA
  const budget = equity * weight

  const bias        = Math.max(0.5, Math.min(1.5, categoryBias))
  const riskDollars = budget * profile.risk_pct * spec.risk_mult * bias
  const stopDist    = price * spec.stop_pct

  // shares so a stop ≈ riskDollars, capped so one position can't exceed its
  // share of the sleeve budget (also handles "share too pricey to fit" → 0).
  let qty = stopDist > 0 ? Math.floor(riskDollars / stopDist) : 0
  const maxByShare = price > 0 ? Math.floor((budget * spec.max_position_share) / price) : 0
  qty = Math.max(0, Math.min(qty, maxByShare))

  return {
    sleeve,
    qty,
    stop_pct:  spec.stop_pct,
    trail_pct: spec.trail_pct,
    hold_days: spec.hold_days,
    budget:    Math.round(budget * 100) / 100,
    risk_dollars: Math.round(riskDollars * 100) / 100,
    note: `${spec.label} ${(weight * 100).toFixed(0)}% budget=$${budget.toFixed(0)} risk=$${riskDollars.toFixed(0)}${bias !== 1 ? ` bias×${bias.toFixed(2)}` : ''}`,
  }
}
