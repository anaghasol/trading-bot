# Quick Reference - Testing & Tuning

## Pre-Launch Testing (Do This First)

### 1. Test Alerts (5 minutes)
```bash
# Configure .env first
ALERT_EMAIL_ENABLED=true
ALERT_SENDER_EMAIL=your-email@gmail.com
ALERT_SENDER_PASSWORD=your-app-password  # Gmail: App Password, not regular password
ALERT_RECIPIENT_EMAIL=your-email@gmail.com
ALERT_SMS_EMAIL=1234567890@txt.att.net  # AT&T: @txt.att.net, Verizon: @vtext.com

# Run test
python test_alerts.py

# Expected: 4 emails/SMS (circuit breaker, latency, major loss, connection lost)
```

### 2. Run 2-Year Backtest (10 minutes)
```bash
python backtest.py

# Target Metrics:
# - Sharpe Ratio: >1.2 (post-slippage)
# - Win Rate: >50%
# - Profit Factor: >1.5
# - Max Drawdown: <5%

# If Sharpe <1.2 on 2022 bear market data:
# → Increase REGIME_BEAR_OPENCLAW_WEIGHT to 0.45 (trust sentiment more)
# → Increase entry threshold to 0.65
```

### 3. Setup Daily Sync (5 minutes)
```bash
# Test manual sync first
./daily_sync.sh

# Should see: "✅ Daily data synced to GitHub"

# Add to crontab (runs 4:30 PM ET Mon-Fri)
crontab -e

# Add this line:
30 16 * * 1-5 cd /Users/akhilreddy/trading-bot && ./daily_sync.sh >> logs/daily_sync.log 2>&1

# Verify
crontab -l
```

---

## Tuning Tips (After 5-10 Paper Sessions)

### Regime Weights (If Underperforming)

**Bull Markets (Strong Uptrends)**
```bash
# Trust technicals more in momentum
REGIME_BULL_OPENCLAW_WEIGHT=0.75  # Up from 0.70
REGIME_BULL_POLY_WEIGHT=0.25      # Down from 0.30
```

**Bear Markets (Downtrends)**
```bash
# Trust sentiment more to avoid falling knives
REGIME_BEAR_OPENCLAW_WEIGHT=0.45  # Down from 0.50
REGIME_BEAR_POLY_WEIGHT=0.55      # Up from 0.50
```

**Flat Markets (Choppy/Sideways)**
```bash
# Tighten entry threshold
REGIME_FLAT_OPENCLAW_WEIGHT=0.60  # Up from 0.55
REGIME_FLAT_POLY_WEIGHT=0.40      # Down from 0.45
```

### ATR Thresholds (If Too Many/Few Trades)

**Too Many Trades (>10/day)**
```bash
REGIME_BULL_ATR=0.035      # Up from 0.03 (stricter)
REGIME_TREND_THRESHOLD=0.025  # Up from 0.02
```

**Too Few Trades (<2/day)**
```bash
REGIME_BULL_ATR=0.025      # Down from 0.03 (looser)
REGIME_FLAT_ATR=0.020      # Up from 0.015
```

---

## Monitoring Checklist (Daily)

### Morning (9:25 AM ET)
- [ ] IBKR TWS/Gateway running on port 7497 (paper) or 7496 (live)
- [ ] Start bot: `python start_live_trading.py`
- [ ] Dashboard accessible: http://localhost:8080
- [ ] Check starting balance matches yesterday's close

### During Trading (Every 2 Hours)
- [ ] Dashboard shows active positions
- [ ] No circuit breaker triggered
- [ ] Latency <10s per loop
- [ ] Trades executing properly

### End of Day (4:05 PM ET)
- [ ] All positions closed at 3:45 PM
- [ ] Bot auto-shutdown at 4:00 PM
- [ ] Review audit log: `logs/audit_YYYY-MM-DD.jsonl`
- [ ] Check daily summary: `logs/summary_YYYY-MM-DD.json`
- [ ] Verify daily sync ran: `tail logs/daily_sync.log`

---

## Performance Tracking (Weekly)

### Review Metrics
```bash
# Check last 7 days performance
grep "pnl" logs/audit_*.jsonl | tail -50

# View ML-lite weight adjustments
cat daily_data/learning/ml_weights_*.json
```

### Key Questions
1. **Win Rate >50%?** If not, increase entry thresholds
2. **Sharpe >1.2?** If not, tighten stops or widen targets
3. **Circuit breaker triggered?** Review what went wrong
4. **Regime detection accurate?** Check if weights need tuning

---

## Common Issues & Fixes

### Issue: Too Many Losses in Bull Market
**Fix:** Increase OpenClaw weight
```bash
REGIME_BULL_OPENCLAW_WEIGHT=0.75
```

### Issue: Missing Good Trades
**Fix:** Lower entry threshold
```bash
# In regime_detector.py get_entry_threshold()
# BULL: 0.58 → 0.55
# FLAT: 0.60 → 0.58
```

### Issue: Holding Losers Too Long
**Fix:** Tighten ATR stop multiplier
```bash
ATR_STOP_MULTIPLIER=1.5  # Down from 2.0
```

### Issue: Taking Profits Too Early
**Fix:** Widen ATR target multiplier
```bash
ATR_TARGET_MULTIPLIER=4.0  # Up from 3.0
```

---

## Quick Commands

```bash
# Start trading
python start_live_trading.py

# Run backtest
python backtest.py

# Test alerts
python test_alerts.py

# Manual sync
./daily_sync.sh

# View today's trades
cat logs/audit_$(date +%Y-%m-%d).jsonl | jq .

# Check circuit breaker status
grep "circuit_breaker" logs/summary_$(date +%Y-%m-%d).json

# Monitor live
tail -f logs/trading_bot.log
```

---

## Success Indicators (Scale Up When...)

- ✅ Win rate >60% for 2+ weeks
- ✅ Sharpe ratio >1.5 consistently
- ✅ Max drawdown <1% per day
- ✅ No circuit breaker triggers in 2 weeks
- ✅ Profit factor >2.0

**Action:** Gradually increase capital (stay under PDT limits)

---

## Red Flags (Stop Trading If...)

- ⚠️ Win rate <40% for 3+ days
- ⚠️ Daily losses >-2% for 2 consecutive days
- ⚠️ Sharpe ratio <0.8
- ⚠️ Circuit breaker triggers 3+ times in a week
- ⚠️ System latency consistently >10s

**Action:** Return to paper trading, re-evaluate strategy
