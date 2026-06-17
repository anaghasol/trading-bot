/**
 * STRATEGY PROFILES — one engine, two personalities.
 *
 *  • Schwab (real, small $)  → PROTECTED: capital preservation first, PDT-safe swing.
 *  • Alpaca (paper, big $)   → AGGRESSIVE LAB: push sizing/turnover to find edge,
 *                              no PDT limit, wider net. Still risk-managed (stops +
 *                              daily breaker) so the test is realistic, not reckless.
 *
 * The scanner reads the profile by broker instead of hard-coding risk numbers.
 * Tune the AGGRESSIVE_LAB freely — it's fake money; that's the whole point.
 */

export interface StrategyProfile {
  key: 'schwab' | 'alpaca_paper'
  label: string
  vibe: 'protected' | 'aggressive'
  risk_pct: number              // fraction of equity risked per trade
  max_positions: number
  min_confidence: number        // AI confidence gate (lower = more trades)
  allow_day_trades: boolean     // paper has no PDT cap → true
  initial_stop_pct: number      // tight protective stop below entry
  trail_pct: number             // trailing stop from peak
  daily_loss_stop_pct: number   // halt-all for the day
  max_hold_days: number
  scan_universe: 'core' | 'wide'// wide = more tickers for the lab
}

export const PROFILES: Record<StrategyProfile['key'], StrategyProfile> = {
  // ── REAL money: grow $2K toward $25K — need to be IN trades to compound ──
  schwab: {
    key: 'schwab',
    label: 'Schwab · Real (Protected)',
    vibe: 'protected',
    risk_pct: 0.02,             // 2% per trade — slightly more assertive (was 1.5%)
    max_positions: 4,           // 4 concurrent (was 3 — room for one more swing)
    min_confidence: 72,         // 72% gate (was 74) — BREAKOUT with ema≥8 now bypasses anyway
    allow_day_trades: false,    // PDT-safe swing (1–5 day holds)
    initial_stop_pct: 0.04,     // 4% initial stop
    trail_pct: 0.05,
    daily_loss_stop_pct: 0.05,  // −5% halts the day
    max_hold_days: 5,
    scan_universe: 'core',
  },

  // ── PAPER money: aggressive lab — use ALL the fake money to find edge ──
  alpaca_paper: {
    key: 'alpaca_paper',
    label: 'Alpaca · Paper (Aggressive Lab)',
    vibe: 'aggressive',
    risk_pct: 0.06,             // 6% per trade — push sizing hard on fake money
    max_positions: 12,          // 12 concurrent
    min_confidence: 32,         // 32% gate — paper is for discovery, not precision (+ bypass for ema≥5)
    allow_day_trades: true,
    initial_stop_pct: 0.04,     // 4% initial stop
    trail_pct: 0.06,            // 6% trailing
    daily_loss_stop_pct: 0.15,  // −15% daily breaker
    max_hold_days: 5,
    scan_universe: 'wide',
  },
}

export function profileFor(broker: string): StrategyProfile {
  return PROFILES[(broker as StrategyProfile['key'])] ?? PROFILES.schwab
}
