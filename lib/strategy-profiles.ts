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
  // ── REAL money: protect first, compound steadily toward $25K ──
  schwab: {
    key: 'schwab',
    label: 'Schwab · Real (Protected)',
    vibe: 'protected',
    risk_pct: 0.015,            // 1.5% per trade  (reviewer's floor)
    max_positions: 3,
    min_confidence: 78,         // only high-conviction
    allow_day_trades: false,    // PDT-safe swing (1–5 day holds)
    initial_stop_pct: 0.025,
    trail_pct: 0.05,
    daily_loss_stop_pct: 0.05,  // −5% halts the day
    max_hold_days: 5,
    scan_universe: 'core',
  },

  // ── PAPER money: aggressive lab, lots of capital, push the edge ──
  alpaca_paper: {
    key: 'alpaca_paper',
    label: 'Alpaca · Paper (Aggressive Lab)',
    vibe: 'aggressive',
    risk_pct: 0.04,             // 4% per trade — bigger swings
    max_positions: 8,           // run many ideas at once
    min_confidence: 68,         // take more setups to gather data
    allow_day_trades: true,     // no PDT on paper → intraday allowed
    initial_stop_pct: 0.03,     // a touch more room
    trail_pct: 0.06,            // let winners run further
    daily_loss_stop_pct: 0.10,  // −10% breaker (still protected, just looser)
    max_hold_days: 3,           // faster turnover for more samples
    scan_universe: 'wide',
  },
}

export function profileFor(broker: string): StrategyProfile {
  return PROFILES[(broker as StrategyProfile['key'])] ?? PROFILES.schwab
}
