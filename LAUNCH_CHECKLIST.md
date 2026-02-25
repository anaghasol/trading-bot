# Launch Checklist - Trading Bot Deployment

## Pre-Launch Validation (Paper Trading)

### 1. Backtesting ✅
- [ ] Run `python backtest.py` on 6-month historical data
- [ ] Verify Sharpe Ratio > 1.2 (post-slippage/commissions)
- [ ] Confirm Win Rate > 50%
- [ ] Confirm Profit Factor > 1.5
- [ ] Check Max Drawdown < 5%

**Target Metrics:**
- Sharpe Ratio: >1.2
- Win Rate: >50%
- Profit Factor: >1.5
- Max Drawdown: <5%
- Avg Daily Return: >0.5%

### 2. Paper Trading Sessions (10-20 Days)
- [ ] Run bot for 10-20 trading sessions
- [ ] Monitor daily P&L in dashboard (http://localhost:8080)
- [ ] Verify circuit breaker triggers at -2% loss
- [ ] Confirm positions close at 3:45 PM ET
- [ ] Check bot auto-shutdown at 4:00 PM ET
- [ ] Review audit logs for trade quality

**Success Criteria:**
- Max Drawdown < 2% per day
- Avg Return > 0.5% per day
- No overnight positions
- Circuit breaker working
- All exits executed properly

### 3. System Checks
- [ ] IBKR TWS/Gateway running on port 7497 (paper)
- [ ] All dependencies installed (`pip install -r requirements.txt`)
- [ ] `.env` file configured with correct settings
- [ ] Logs directory exists and writable
- [ ] Dashboard accessible at http://localhost:8080
- [ ] Alert system configured (optional)

### 4. Risk Management Validation
- [ ] Verify 1% position sizing rule enforced
- [ ] Confirm ATR-based stops (2x ATR)
- [ ] Check 2:1 reward:risk ratio on targets
- [ ] Test diversification limits (max 2 per sector)
- [ ] Validate volume filter (2x average)
- [ ] Confirm regime detection working

### 5. Feature Testing
- [ ] Dual validation (OpenClaw + Polymarket) working
- [ ] Fallback handler activates if dependency fails
- [ ] News monitor pauses trading around events
- [ ] Latency monitor alerts on >10s delays
- [ ] Audit logger recording all trades
- [ ] ML-lite weight adjustment based on 7-day accuracy

---

## Live Trading Launch (When Ready)

### 1. Configuration Changes
- [ ] Update `.env`: `IBKR_PORT=7496` (live trading)
- [ ] Update `.env`: `PAPER_TRADING=false`
- [ ] Set initial capital: $1,000 - $5,000 (under PDT limit)
- [ ] Configure alert escalation (email/SMS)

### 2. First Week Monitoring
- [ ] Check dashboard every 2 hours during market hours
- [ ] Review audit logs daily
- [ ] Monitor circuit breaker triggers
- [ ] Track win rate and profit factor
- [ ] Verify no overnight positions

### 3. Weekly Review
- [ ] Analyze weekly performance metrics
- [ ] Review ML-lite weight adjustments
- [ ] Check regime detection accuracy
- [ ] Evaluate sector diversification
- [ ] Update strategy if needed

---

## Ongoing Maintenance

### Daily
- [ ] Check dashboard at market open (9:30 AM ET)
- [ ] Monitor positions during trading hours
- [ ] Verify clean shutdown at 4:00 PM ET
- [ ] Review daily summary logs

### Weekly
- [ ] Run backtest on recent data
- [ ] Analyze 7-day performance metrics
- [ ] Review ML-lite weight adjustments
- [ ] Check for system updates

### Monthly
- [ ] Re-backtest strategy on 6-month data
- [ ] Evaluate overall performance (Sharpe, win rate, profit factor)
- [ ] Research market regime changes
- [ ] Update strategy parameters if needed
- [ ] Review and optimize position sizing

---

## Emergency Procedures

### Circuit Breaker Triggered
1. Bot auto-stops trading for the day
2. Review audit logs to identify cause
3. Check for system issues (latency, connection)
4. Evaluate if strategy adjustment needed
5. Resume next trading day

### Connection Lost
1. Alert escalation notifies via email/SMS
2. Bot attempts reconnection
3. Manual intervention: restart TWS/Gateway
4. Verify all positions closed properly
5. Check for orphaned orders

### Major Loss (>5% on single position)
1. Alert sent immediately
2. Review entry signals (OpenClaw + Polymarket scores)
3. Check if stop-loss executed properly
4. Evaluate if ATR calculation was accurate
5. Adjust risk parameters if needed

---

## Performance Targets

### Daily
- Return: >0.5%
- Max Drawdown: <2%
- Win Rate: >50%

### Weekly
- Return: >2.5%
- Max Drawdown: <5%
- Sharpe Ratio: >1.2

### Monthly
- Return: >10%
- Max Drawdown: <10%
- Profit Factor: >1.5

---

## Red Flags (Stop Trading If...)

- Win rate drops below 40% for 3+ days
- Daily losses exceed -2% for 2 consecutive days
- Sharpe ratio falls below 0.8
- Circuit breaker triggers 3+ times in a week
- System latency consistently >10s
- Connection issues persist

**Action:** Pause live trading, return to paper trading, re-evaluate strategy.

---

## Success Indicators (Scale Up If...)

- Win rate >60% for 2+ weeks
- Sharpe ratio >1.5 consistently
- Max drawdown <1% per day
- Profit factor >2.0
- No circuit breaker triggers in 2 weeks

**Action:** Gradually increase capital allocation (stay under PDT limits).
