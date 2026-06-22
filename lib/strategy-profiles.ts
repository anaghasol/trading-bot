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
    max_positions: 4,           // 4 concurrent PDT-safe swings
    min_confidence: 72,         // 72% gate — BREAKOUT with ema≥8 now bypasses anyway
    allow_day_trades: false,    // PDT-safe swing (1–5 day holds)
    initial_stop_pct: 0.04,     // 4% initial stop — real money needs room
    trail_pct: 0.05,
    daily_loss_stop_pct: 0.05,  // −5% halts the day
    max_hold_days: 5,
    scan_universe: 'core',
  },

  // ── PAPER money: quality over quantity — 20 positions, strict gate ──
  alpaca_paper: {
    key: 'alpaca_paper',
    label: 'Alpaca · Paper (Quality Mode)',
    vibe: 'aggressive',
    risk_pct: 0.03,             // 3% per trade — fewer positions → more per entry
    max_positions: 20,          // 20 max — 25% WR with 40 was catastrophic; quality > quantity
    min_confidence: 36,         // 36% floor (tuner raised to 32% after PF=0.17 — need higher baseline)
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
