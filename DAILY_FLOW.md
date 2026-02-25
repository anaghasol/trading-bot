# Complete Daily Trading Flow - Start to End

## 🌅 Pre-Market (Before 9:30 AM ET)

### 1. Bot Startup
```bash
python live_engine.py
# or
python start_live_trading.py  # with dashboard
```

**What Happens:**
- ✅ Load `trading_state.json` (yesterday's state)
- ✅ Clean up trades older than 7 days
- ✅ Connect to IBKR (TWS/Gateway must be running)
- ✅ Get starting balance from IBKR
- ✅ Set `starting_balance` for today's P&L tracking
- ✅ Initialize trending stock scanner
- ✅ Start dashboard on `localhost:8080`

**Console Output:**
```
🚀 Live Trading Started - SMART EXIT STRATEGY
💰 Balance: $933,527.06
🎯 Max Positions: 8
📈 STOCKS: +1.5% take profit | -1% stop loss
🎯 OPTIONS: +3% take profit | -2% stop loss
⏰ Auto-close all at 3:45 PM ET
🛑 Bot stops at 4:00 PM ET (market close)
```

---

## 📊 Market Open (9:30 AM - 3:45 PM ET)

### 2. Every 90 Seconds - Main Trading Loop

#### Step 1: Scan Trending Stocks
```
🔄 Refreshing trending stocks...
Found 10 trending: NFLX, TSLA, AAPL, AMD, NVDA, META, GOOGL, MSFT, AMZN, SPY
```

**How it works:**
- Market scanner finds top 10 most active stocks
- Based on: volume surge, price movement, volatility
- Refreshes every 15 minutes (10 scans)

#### Step 2: Update Existing Positions
```
⏰ 10:15:30 - Scanning 10 trending stocks...

💰 Balance: $933,527 | P&L: -$66,473

📊 NFLX: +0.8% (peak 1.2%) | 45min | trend 72% | HOLD +0.8%
📊 TSLA: +0.3% (peak 0.5%) | 38min | trend 68% | HOLD +0.3%
📊 AAPL: +0.1% (peak 0.2%) | 32min | trend 65% | HOLD +0.1%
📊 AMD: -0.03% (peak 0.1%) | 28min | trend 58% | HOLD -0.03%
📊 DDOG: +0.3% (peak 0.4%) | 25min | trend 61% | HOLD +0.3%
```

**For each position:**
1. Get current price from yfinance
2. Calculate P&L and P&L%
3. Check exit conditions:
   - ❌ Stop-loss: Stock -1%, Option -2%
   - ✅ Take-profit: Stock +1.5%, Option +3%
   - 🔄 Trailing stop: Peak 2%+ → don't drop below 1%
   - 📉 Trend reversal: Trend < 45% and P&L < 0.5%
4. If exit condition met → Close position
5. Otherwise → Hold and continue monitoring

**Exit Example:**
```
💰 CLOSING NFLX - TAKE PROFIT +1.6% (stock)
✅ CLOSED NFLX | P&L: $1,007.35 (+0.84%)
📊 Daily profit logged: NFLX $1,007.35
```

#### Step 3: Analyze New Opportunities

For each trending stock (if < 8 positions):

**A. Check Price Movement**
```python
current_price = $272.14
prev_price = $271.80
change_pct = +0.12%
```

If `abs(change_pct) > 0.5%` → Analyze further

**B. OpenClaw Technical Analysis**
```
📈 OpenClaw analyzing AAPL...
- SMA 5: $271.50
- SMA 20: $268.30
- Volume surge: 1.3x
- Volatility: 2.1%
- Trend score: 68%
```

**C. Polymarket Crowd Sentiment**
```
🔮 Polymarket analyzing AAPL...
- Found 3 markets mentioning AAPL
- Market 1: "AAPL above $275 by Friday" → 62% YES
- Market 2: "AAPL earnings beat" → 71% YES
- Market 3: "Tech stocks rally" → 58% YES
- Weighted average: 65% bullish
- Confidence: 60% (3 markets found)
```

**D. Combined Decision**
```python
openclaw_trend = 68%  # > 55% ✓
polymarket_prob = 65%  # > 55% ✓
combined_confidence = (0.68 * 0.6) + (0.65 * 0.4) = 66.8%  # > 60% ✓

BOTH AGREE → TRADE!
```

**Trade Execution:**
```
✅ STRONG BUY AAPL: OpenClaw 68% + Polymarket 65% = 67%
📈 BUY 441 AAPL @ $272.14 (conf: 67%)
✅ BUY 441 AAPL @ $272.14 (conf: 67%)
```

**Skip Example (No Consensus):**
```
⏭️  SKIP AMD: OpenClaw 52%, Polymarket 48% (no consensus)
```

#### Step 4: Position Summary
```
📊 Positions: 5/8 | P&L: -$64,631
```

**Repeat every 90 seconds until 3:45 PM**

---

## 🕒 3:45 PM ET - Pre-Market Close

### 3. Close All Positions
```
⏰ 3:45 PM - Closing all positions before market close

💰 CLOSING NFLX - End of day
✅ CLOSED NFLX | P&L: $1,007.35 (+0.84%)

💰 CLOSING TSLA - End of day
✅ CLOSED TSLA | P&L: $322.30 (+0.27%)

💰 CLOSING AAPL - End of day
✅ CLOSED AAPL | P&L: $147.74 (+0.12%)

💰 CLOSING AMD - End of day
✅ CLOSED AMD | P&L: -$39.20 (-0.03%)

💰 CLOSING DDOG - End of day
✅ CLOSED DDOG | P&L: $403.20 (+0.34%)

✅ All positions closed - waiting for market close
```

**What Happens:**
- All open positions closed at market price
- P&L logged to `logs/daily_profits_2026-02-24.txt`
- Trades marked as CLOSED in `trading_state.json`
- Bot waits 15 minutes until market close

---

## 🛑 4:00 PM ET - Market Close

### 4. Bot Shutdown
```
🛑 Market closed - shutting down bot

📊 Daily Summary:
   Starting Balance: $1,000,000.00
   Ending Balance: $933,527.06
   Daily P&L: -$66,472.94
   
   Total Trades: 8
   Closed: 3 (losses)
   Open at close: 5 (mixed)
   
   Win Rate: 37.5% (3 wins, 5 losses)

Bot stopped. Restart tomorrow at 9:30 AM.
```

**Final State Saved:**
```json
{
  "positions": {},  // All closed
  "trades": [
    {"symbol": "ZS", "status": "CLOSED", "pnl": -1335.61},
    {"symbol": "MDB", "status": "CLOSED", "pnl": -1573.80},
    {"symbol": "TWLO", "status": "CLOSED", "pnl": -131.50},
    {"symbol": "NFLX", "status": "CLOSED", "pnl": 1007.35},
    {"symbol": "TSLA", "status": "CLOSED", "pnl": 322.30},
    {"symbol": "AAPL", "status": "CLOSED", "pnl": 147.74},
    {"symbol": "AMD", "status": "CLOSED", "pnl": -39.20},
    {"symbol": "DDOG", "status": "CLOSED", "pnl": 403.20}
  ],
  "balance": 933527.06,
  "starting_balance": 1000000.0,
  "daily_pnl": -66472.94
}
```

---

## 📈 Dashboard (Real-Time All Day)

### Available at `http://localhost:8080`

**Shows:**
- Current balance and daily P&L
- Open positions with live P&L
- All trades (open + closed)
- Market analysis (hot stocks)
- Trade log with entry/exit prices

**Updates every 2 seconds**

---

## 🔄 Next Day (9:30 AM ET)

### 5. Fresh Start
```bash
python live_engine.py
```

**What Happens:**
- Load yesterday's ending balance as today's starting balance
- Reset `daily_pnl` to $0
- Keep trade history (up to 7 days)
- Start fresh with 0 positions
- Begin new trading day

---

## 📊 Complete Flow Diagram

```
9:30 AM
   ↓
[BOT START]
   ↓
Load State → Connect IBKR → Get Balance → Start Dashboard
   ↓
   ↓ ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
   ↓                                                      ↑
[MAIN LOOP - Every 90 seconds]                          ↑
   ↓                                                      ↑
Scan Trending Stocks (10 stocks)                        ↑
   ↓                                                      ↑
Update Positions:                                        ↑
   - Get current prices                                  ↑
   - Calculate P&L                                       ↑
   - Check stop-loss (-1% stock, -2% option)            ↑
   - Check take-profit (+1.5% stock, +3% option)        ↑
   - Check trailing stop (peak 2%+ → floor 1%)          ↑
   - Check trend reversal (< 45% trend)                 ↑
   - Close if exit condition met                        ↑
   ↓                                                      ↑
Analyze New Opportunities (if < 8 positions):           ↑
   - Check price movement (> 0.5%)                      ↑
   - OpenClaw: Technical analysis (trend score)         ↑
   - Polymarket: Crowd sentiment (probability)          ↑
   - Combined: Both must agree (> 55% each)             ↑
   - Execute trade if consensus                         ↑
   ↓                                                      ↑
Log Status:                                              ↑
   - Positions: X/8                                      ↑
   - Daily P&L: $X,XXX                                   ↑
   ↓                                                      ↑
Sleep 90 seconds                                         ↑
   ↓                                                      ↑
   ↓ → → → → → → → → → → → → → → → → → → → → → → → → → →
   ↓
3:45 PM
   ↓
[CLOSE ALL POSITIONS]
   ↓
Close each position at market price
Log final P&L for each trade
Save state
   ↓
Wait 15 minutes
   ↓
4:00 PM
   ↓
[SHUTDOWN]
   ↓
Display daily summary
Disconnect IBKR
Stop bot
```

---

## 🎯 Key Decision Points

### Entry Decision
```
Price moved > 0.5%
    ↓
OpenClaw Analysis
    ↓
Trend > 55%? → NO → SKIP
    ↓ YES
Polymarket Analysis
    ↓
Probability > 55%? → NO → SKIP
    ↓ YES
Combined > 60%? → NO → SKIP
    ↓ YES
EXECUTE TRADE
```

### Exit Decision
```
For each position every 90 seconds:

Check Stop-Loss:
  Stock: P&L ≤ -1% → EXIT
  Option: P&L ≤ -2% → EXIT

Check Take-Profit:
  Stock: P&L ≥ +1.5% → EXIT
  Option: P&L ≥ +3% → EXIT

Check Trailing Stop:
  Peak ≥ 2% AND Current < 1% → EXIT

Check Trend:
  Trend < 45% AND P&L < 0.5% → EXIT

Otherwise:
  HOLD
```

---

## 📝 Files Generated Daily

1. **trading_state.json** - Current state (positions, trades, balance)
2. **logs/daily_profits_2026-02-24.txt** - Trade log with P&L
3. **logs/trading_bot.log** - Detailed execution log

---

## 🎯 Expected Daily Results

**Target:** +0.5% to +1% per day

**Example Good Day:**
```
Trades: 12
Wins: 8 (67%)
Losses: 4 (33%)
Daily P&L: +$8,500 (+0.85%)
```

**Example Bad Day (Today):**
```
Trades: 8
Wins: 3 (37%)
Losses: 5 (63%)
Daily P&L: -$66,473 (-6.6%)
```

**With New Strategy:**
- Faster stop-loss cuts losses at -1%
- Faster take-profit locks gains at +1.5%
- Dual validation (OpenClaw + Polymarket) prevents bad trades
- Auto-close at 3:45 PM prevents overnight risk

---

## 🚀 How to Run

```bash
# Start bot
python live_engine.py

# Or with dashboard
python start_live_trading.py

# View dashboard
open http://localhost:8080

# Monitor logs
tail -f logs/trading_bot.log
```

Bot runs automatically from 9:30 AM to 4:00 PM ET, then stops.
