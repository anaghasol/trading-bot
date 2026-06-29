# MyTrade — Strategy, Flow & Learning System

> Living document. Update when rules change. Everything configurable lives in `tb_settings` (Supabase) or `lib/strategy-profiles.ts`.

---

## 1. Two Accounts, Two Personalities

| | Paper (Alpaca) | Live (Schwab) |
|---|---|---|
| Balance | ~$81K (started $100K) | ~$2.1K |
| Goal | Lab — test strategies aggressively | Grow to $25K (PDT threshold) |
| Risk/trade | 3% equity (2% in recovery) | 2% equity |
| Max positions | 20 (15 in recovery) | 4 |
| Day trades | Unlimited | PDT-safe (swing only) |
| AI gate | 42% + tuner adjustments | 72% |
| Stop loss | 2.5% initial, 5% trail | 4% initial, 5% trail |
| Daily breaker | −15% (−12% in recovery) | −5% |

**Recovery Mode** auto-triggers when paper drops below $85K. Deep Recovery at $75K. Both auto-exit when equity recovers. No manual intervention needed.

---

## 2. Full Signal Flow (Every 10 Minutes)

```
┌─────────────────────────────────────────────────────┐
│  SIGNAL SOURCES (run in parallel)                   │
│                                                     │
│  1. EMA Scanner        — 200+ tickers, finds setups │
│  2. Alpaca News        — recent headlines per ticker│
│  3. Polymarket Macro   — prediction market context  │
│  4. TG: US Equities    — explicit entries + watch   │
│  5. TG: Jimmy's Life   — crypto futures → proxies   │
│  6. Supercycle Queue   — weekly RS+200MA screener   │
│  7. Hot List           — intraday volume×move movers│
│  8. Learning Context   — last 7 days of outcomes    │
│  9. Learned Rules      — AI-written rules from EOD  │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│  AI SCORING (Groq sequential chain)                 │
│                                                     │
│  1st try: llama-3.3-70b-versatile  (best quality)  │
│  → 429/503: llama3-70b-8192        (separate quota) │
│  → 429/503: gemma2-9b-it           (Google pool)   │
│  → 429/503: llama-3.1-8b-instant   (never limits)  │
│  → all fail: Claude Sonnet         (paid, rare)     │
│                                                     │
│  Each setup gets: symbol, confidence 0-100%,        │
│  setup type, reason, target%, stop%, hold_mode      │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│  CONFIDENCE BOOST LAYER                             │
│                                                     │
│  Base AI score:              e.g. 72%               │
│  + TG explicit BUY/SELL:       +15  (last 4h)       │
│  + TG watchlist mention:        +8  (last 2h)       │
│  + Supercycle queue:           +12  (last 7d)       │
│  + Hot list today:             +12  (last 90min)    │
│  + Buy zone (price-matched):  +10–15                │
│  + Watch-only intention:        +5                  │
│  + Re-entry (recent stop):      +5                  │
│  ─────────────────────────────────────              │
│  Final score:                e.g. 87%               │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│  QUALITY GATE (paper only, non-trend positions)     │
│                                                     │
│  ✓ RS vs SPY ≥ 1.4  (stock outperforms market)     │
│  ✓ Research score ≥ 7.0                             │
│  ✓ EMA score ≥ 5 OR confidence above gate           │
│  ✓ Not a leveraged/inverse ETF (30+ tickers banned) │
│  ✓ Final confidence ≥ gate (42% + tuner adj)        │
│  ✓ Market regime not BAD (VIX too high)             │
│  ✓ Daily breaker not hit                            │
│  ✓ Max positions not hit                            │
│  ✓ Not already held, not in avoid list              │
└─────────────────────────────────────────────────────┘
            │
            ▼
          ENTRY → position opened on Alpaca paper + optionally Schwab live
```

---

## 3. Telegram Channel Integration (Every 1 Minute)

### Channels
| Channel | Handle | Mode | Signal Style |
|---------|---------|------|-------------|
| US Equities | @OptionT1 | Active — trades | Explicit "Buy X at Y SL Z", watchlists, momentum callouts |
| Jimmy's Life | @JimmyLeshTrades | Active — trades | Crypto futures (XRPUSDT LONG entry X SL Y), TP hit updates |
| SF Essential Trades | private | Muted — learn only | General macro/equity commentary |

### What Happens Per Message
```
Message arrives from active channel
    │
    ├─ isWorthClassifying()? No → skip (too short, no keywords)
    │
    ├─ Groq classifies: trade / exit / learn / ignore
    │   (with channel-specific context so it knows the signal format)
    │
    ├─ type: trade   → execute on Alpaca paper (+ Schwab if conf ≥ 72%)
    │                  → write TG✓ to tb_alerts (scan gives +15 next tick)
    │                  → log: [TG][Channel] BUY 50 AMD @ $210.50 SL209 conf=88%
    │
    ├─ type: exit    → close position if held
    │                  → log: [TG][Channel] EXIT AMD — closed
    │
    ├─ type: learn (actionable, bullish) → write TG_WATCH to tb_alerts
    │                  → scan gives +8 to each ticker next tick
    │                  → log: [TG][Channel] WATCH AMD — +8 scan boost queued
    │
    └─ type: learn (macro bearish) → set tg_macro_stance = bearish for 18h
                       → scanner pauses new entries until stance clears
```

### Crypto → Equity Proxy Map
```
BTC/BTCUSD     → MSTR    XRP/XRPUSDT   → COIN
ETH/ETHUSD     → COIN    SOL/SOLUSDT   → COIN
POL/MATIC      → COIN    ADA/ADAUSDT   → COIN
SPX/ES         → SPY     NDX/NQ        → QQQ
RUT/RTY        → IWM     GOLD/XAUUSD   → GLD
OIL/CL/WTI     → USO     BNB           → COIN
```

---

## 4. Exit Strategy (In Priority Order)

```
Every 2 minutes (monitor cron):

1. HARD STOP (emergency)
   Paper: position down −8% (Alpaca's own P/L — immune to bad entry price)
   Live:  position down −5%
   → Close immediately, no questions asked

2. Initial stop (placed at entry)
   Paper: −2.5% from entry
   Live:  −4.0% from entry
   → Ratchets up with trail, never moves down

3. Trailing stop (activated once position has any gain)
   Paper: 5% from peak price
   Live:  5% from peak price
   → Locks in profits as stock rises

4. Partial P1 (first take-profit)
   Triggered: position +4% unrealized
   Action: sell 30% of shares at market
   → Locks in some profit, rest continues with trail

5. Partial P2 (second take-profit)
   Triggered: position +8% unrealized
   Action: sell another 30% of remaining shares
   → Now 40% of original position left, running on loose trail

6. Trend mode (hold_mode = 'trend')
   Positions tagged 'trend' skip standard stop — trail only
   Used for SNDK-style runners and Discovery picks with strong momentum

7. EOD (3:30–3:45 PM ET — close cron)
   Paper day trades: close losing ones; winners left to run overnight
   Schwab: never forced closed (PDT-safe swing positions)

8. Max hold
   Paper: 3 days
   Schwab: 5 days
   → If still open after max hold: close at next scan tick

9. TG exit signal
   If US Equities or Jimmy says "exit TICKER" and we hold it → close immediately

10. Earnings guard (monitor)
    Night before earnings: tighten trail to 2% to protect against gap risk
```

---

## 5. How the Bot Learns Every Day

### What Gets Captured

```
During the day (continuous):
  tb_learning rows:
    - Every TG signal classified → symbol, sentiment, sector, insight, source
    - Every TP hit from Jimmy/US Equities → commodity/crypto momentum note
    - Every trade entry → AI rationale stored

At EOD (3:15–3:30 PM ET — eod cron):
  tb_eod_reports row:
    - P&L, win rate, profit factor
    - Avg win vs avg loss
    - Entries, stops fired, partials taken
    - Best and worst performers
    - Market tier (GOOD/TOUGH/BAD)
    - Regime (NORMAL/CAUTION/RISK_OFF)

  tb_settings key='learned_rules':
    - EOD tuner WRITES new rules based on day's outcomes
    - Example: "AVOID BREAKOUT in CAUTION regime — 3 losses today"
    - Example: "EMA20_BOUNCE working well in NORMAL — raise confidence floor"

  tb_settings key='min_confidence', 'stop_pct', 'trail_pct', 'max_positions':
    - EOD tuner adjusts these based on win rate and profit factor
    - Stacks correctly (each handler reads accumulated patch, not original config)
```

### How Learning Feeds Back In (Next Scan)

```
buildLearningContext() [lib/learning.ts]:
  Reads last 50 closed trades (7 days)
  Computes:
    - win_rate_7d
    - best_setups (avg P&L > 0, ≥2 trades)
    - avoid_setups (avg P&L < −2%, ≥2 trades)
    - regime_performance (which market condition we win in)
    - recent_losses (last 5 losers — what not to repeat)
    - TG intention context (Pavan's current buy zones / avoids)

learnedRules [tb_settings key='learned_rules']:
  AI-written rules from EOD tuner, last 7 days
  Injected directly into Groq prompt:
  "LEARNED RULES (respect these):
   • AVOID BREAKOUT setups when regime=CAUTION — 3 losses
   • EMA20_BOUNCE in NORMAL regime — avg +3.2%
   • TREND positions: ignore standard stops, trail only"

Groq sees ALL of this per scan:
  - Chart data (EMA scores, RS, research score)
  - News context (Alpaca headlines)
  - Polymarket macro (prediction market signals)
  - TG signal flags (TG✓, SC✓, HL✓, S2✓, DISCOVERY)
  - Learning summary (what worked last 7 days)
  - Learned rules (written by EOD tuner)
  - TG intentions (buy zones, avoids from channel analysis)
```

---

## 6. EOD Tuner — Self-Adjusting Config

The EOD tuner runs at ~3:15 PM ET and adjusts `tb_settings` for the next day:

```
Metric          → Action
─────────────────────────────────────────────────────
WR < 35%        → raise min_confidence +5pp (be more selective)
WR < 25%        → raise min_confidence +8pp (crisis mode)
WR > 55%        → lower min_confidence −3pp (can be looser)
WR > 65%        → lower min_confidence −5pp (very confident)

PF < 0.5        → raise min_confidence +3pp AND tighten stop −0.3%
PF > 2.0        → loosen stop +0.5% (giving winners more room)

Avg loss > 3.5% → tighten stop by −0.5%
Avg win  < 1.5% → raise gate +3pp (exits too early or picks too weak)

Max positions   → adjusts ±1–2 based on deployment success
```

Tuner floor: min_confidence never goes below 42% (observed 19% WR at 36%).  
Tuner ceiling: min_confidence never goes above 85%.

---

## 7. Market Regime Awareness

```
marketTier (from VIX + SMA in scan):
  GOOD   → Full position size, all setups eligible
  TOUGH  → Reduce max positions by 20%, raise gate +3pp
  BAD    → No new entries (only manage existing)

regime (from getMarketRegime()):
  NORMAL    → Standard operation
  CAUTION   → Skip BREAKOUT setups, prefer EMA20_BOUNCE
  RISK_OFF  → Only allow TG-confirmed or trend positions

tg_macro_stance (from TG bearish signal):
  bearish → pause all new entries for 18h
  bullish → no effect on entry (scanner still filters independently)

event_pause_until (from TG FOMC/CPI/NFP mention):
  Detected event time → pause new live entries for ±1.5h window
```

---

## 8. Options Strategy (TG-Triggered Only)

Currently the bot handles single-leg options from TG signals:

```
Signal comes in with OCC symbol (e.g. AMD260724C00210000):
  → Parse: AMD $210 Call, expiry 2026-07-24
  → Skip if DTE < 3 days (too risky)
  → Skip if options exposure ≥ 15% of equity
  → Size: risk 2% of equity on premium paid
  → Place MARKET order
  → Stop: −25% of premium paid
  → Target: +80% / +100% premium gain
```

**Post-Earnings IV Crush** (your friend's suggestion — partially built):
```
Before earnings: IV is high → options are expensive (IV Rank > 50% = sell)
After earnings:  IV collapses ("IV crush") → put sellers profit from premium decay

How IV data works (no external API needed):
  - Yahoo Finance provides earnings dates via calendarEvents module → getEarningsInfo()
  - We compute 30-day Historical Volatility (HV30) from our existing OHLCV price data
  - HV30 > 38% = "elevated" = proxy for high IV → options are expensive → good to sell
  - Groq now sees hv30 and earnings_date for every stock it rates
  - Example Groq prompt entry: { sym:"NVDA", hv30:"52.3%", earnings:"2026-08-14", ... }

Strategy (stock trade version — no options account needed):
  Day before earnings:
    - Bot sees hv30 > 38% + earnings in 1-2 days
    - Does NOT enter (earnings_soon=true blocks entry)
    - Notes the stock as IV-rich candidate

  Morning after earnings:
    - If stock gap < 5%: IV crushed, stock likely range-bound → buy dip, tight target
    - If stock gap > 8%: skip — stock moved too much, different play

Full put-selling version (future):
  Status: needs options-level-2 account on Alpaca + put-selling order type
  Logic: sell ATM put after earnings, exit at 50% profit (IV collapse)
  Risk: stock gaps down past put strike → max loss = strike × 100 - premium collected

When to add: when paper exits recovery + Alpaca options enabled on account.
```

---

## 9. Configurable Parameters (Where to Change Them)

| Parameter | Location | Current Value |
|-----------|----------|---------------|
| Risk per trade (paper) | `lib/strategy-profiles.ts` | 3% (2% in recovery) |
| Risk per trade (live) | `lib/strategy-profiles.ts` | 2% |
| AI confidence gate | `tb_settings.min_confidence` | 42 (base, tuner adjusts) |
| Initial stop % | `tb_settings.stop_pct` | 0.025 (2.5%) |
| Trailing stop % | `tb_settings.trail_pct` | 0.05 (5%) |
| Max positions | `tb_settings.max_positions` | 20 (15 in recovery) |
| Daily loss breaker | `lib/strategy-profiles.ts` | 15% paper / 5% live |
| TG boost — executed trade | `app/api/cron/scan/route.ts` | +15 |
| TG boost — watchlist | `app/api/cron/scan/route.ts` | +8 |
| Supercycle boost | `app/api/cron/scan/route.ts` | +12 |
| Hot list boost | `app/api/cron/scan/route.ts` | +12 |
| Paper partial P1 trigger | `app/api/cron/monitor/route.ts` | +4% |
| Paper partial P2 trigger | `app/api/cron/monitor/route.ts` | +8% |
| Recovery mode threshold | `app/api/cron/scan/route.ts` | $85K (15% drawdown) |
| Deep recovery threshold | `app/api/cron/scan/route.ts` | $75K (25% drawdown) |
| RS filter (paper) | `app/api/cron/scan/route.ts` | ≥ 1.4 |
| Research score filter | `app/api/cron/scan/route.ts` | ≥ 7.0 |
| EMA bypass floor | `app/api/cron/scan/route.ts` | ema ≥ 5, conf floor 65% |
| Crypto proxy map | `app/api/telegram/poll/route.ts` | hardcoded INDEX_MAP |
| Learned rules (auto) | `tb_settings.learned_rules` | written by EOD tuner |

---

## 10. Goal

Paper: $81K → $85K (exit recovery) → $100K (full mode) → eventual real deployment  
Live:  $2.1K → $25K (PDT threshold unlocks unlimited day trades on Schwab)

Once live Schwab hits $25K: can enable day trading on live account, significantly increasing compounding speed.
