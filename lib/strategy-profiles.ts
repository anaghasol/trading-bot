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
    risk_pct: 0.02,             // 2% per trade
    max_positions: 5,           // 5 concurrent PDT-safe swings (was 4)
    min_confidence: 68,         // 68% gate (was 72) — allows strong TG + EMA setups
    allow_day_trades: false,    // PDT-safe swing (1–5 day holds)
    initial_stop_pct: 0.025,    // 2.5% tight stop — cut losses faster on live money
    trail_pct: 0.05,
    daily_loss_stop_pct: 0.05,  // −5% halts the day (hard protection)
    max_hold_days: 5,
    scan_universe: 'core',
  },

  // ── PAPER money: quality over quantity — 20 positions, strict gate ──
  alpaca_paper: {
    key: 'alpaca_paper',
    label: 'Alpaca · Paper (Quality Mode)',
    vibe: 'aggressive',
    risk_pct: 0.03,             // 3% per trade (recovery mode auto-reduces to 2% / 1.5%)
    max_positions: 20,          // 20 max (recovery mode caps at 15 / 10)
    min_confidence: 42,         // raised 36→42: observed 19% WR at 36% — floor must reflect reality.
                                // EOD tuner raises from this floor; cold-start resets here, not to 36.
    allow_day_trades: true,
    initial_stop_pct: 0.025,    // 2.5% stop — auto-tuner hit 1% which is too tight for noise; reset
    trail_pct: 0.05,            // 5% trailing — give winners more room (avg win was only $52)
    daily_loss_stop_pct: 0.15,  // −15% daily breaker (tighter than before — protect capital)
    max_hold_days: 3,           // 3-day max — if it hasn't moved, move on
    scan_universe: 'wide',
  },
}

export function profileFor(broker: string): StrategyProfile {
  return PROFILES[(broker as StrategyProfile['key'])] ?? PROFILES.schwab
}
