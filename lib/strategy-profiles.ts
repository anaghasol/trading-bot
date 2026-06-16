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
    min_confidence: 83,         // raised 78→83: EMA20_BOUNCE had 19% win rate at 78%
    allow_day_trades: false,    // PDT-safe swing (1–5 day holds)
    initial_stop_pct: 0.04,     // widened 2.5%→4%: 2.5% was too tight, noise-stopped winners
    trail_pct: 0.05,
    daily_loss_stop_pct: 0.05,  // −5% halts the day
    max_hold_days: 5,
    scan_universe: 'core',
  },

  // ── PAPER money: tuned after June 4 -10% day — still aggressive but survivable ──
  alpaca_paper: {
    key: 'alpaca_paper',
    label: 'Alpaca · Paper (Aggressive Lab)',
    vibe: 'aggressive',
    risk_pct: 0.055,            // 5.5% per trade (down from 7% — survived June 4 review)
    max_positions: 10,          // 10 concurrent (down from 15 — reduces coordinated-drop exposure)
    min_confidence: 55,         // 55% gate (up from 50%)
    allow_day_trades: true,
    initial_stop_pct: 0.035,    // 3.5% initial stop (tighter — was 5%)
    trail_pct: 0.06,            // 6% trailing (was 10%)
    daily_loss_stop_pct: 0.15,  // −15% daily breaker (was −20%)
    max_hold_days: 5,
    scan_universe: 'wide',
  },
}

export function profileFor(broker: string): StrategyProfile {
  return PROFILES[(broker as StrategyProfile['key'])] ?? PROFILES.schwab
}
