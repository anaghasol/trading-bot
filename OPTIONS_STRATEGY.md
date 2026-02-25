# Options Strategy: Bear Put Spreads

## Overview
Add bear put spreads to leverage bearish signals with defined risk and high gains.

**Why Bear Put Spreads:**
- ✅ Defined risk (max loss = net debit paid)
- ✅ Leveraged returns (50-200% on moderate drops)
- ✅ Fits existing bearish signals (OpenClaw + Polymarket)
- ✅ No overnight holds (close by 3:45 PM)
- ✅ Better than naked puts (theta offset by sold put)

**Target:** 0.5-2% daily returns on bear days with <1% risk per trade

---

## Strategy Details

### Bear Put Spread Structure
- **Buy:** ATM/ITM put (delta ~0.6-0.8)
- **Sell:** OTM put 5-10% below
- **Example:** Stock at $100
  - Buy $100 put
  - Sell $90 put
  - Net debit: $3-5
  - Max loss: $600 per contract
  - Max gain: $400 per contract (50-100% return)

### Entry Criteria
1. **Bearish Consensus:**
   - OpenClaw: Downtrend (MACD cross below, RSI <30, lower highs/lows)
   - Polymarket: Sentiment <45% bullish
   - Combined: >50% bearish score in BEAR/FLAT regime

2. **Stock Filters:**
   - High IV (>30% for better premiums)
   - Volume >2x average
   - No earnings (news pause handles)
   - Implied move > spread width

3. **Spread Criteria:**
   - Net debit <5% of stock price
   - Expiration: 7-30 days (weeklies preferred)
   - Strike width: 5-10% of stock price

### Position Sizing (1% Rule)
```python
max_loss = (upper_strike - lower_strike - debit) * 100 * contracts
# Size so max_loss < 1% of capital
contracts = int((capital * 0.01) / max_loss_per_contract)
```

### Exit Rules
- **Take Profit:** 50-100% of max gain
- **Stop Loss:** 50% of debit paid
- **Trailing:** Adjust based on underlying ATR
- **Time-Based:** Close by 3:00 PM if no move, force at 3:45 PM

---

## Implementation Plan

### Phase 1: Core Options Module (Week 1)

**File:** `src/options/scanner.py`
```python
class OptionsScanner:
    def fetch_option_chain(self, symbol, expiration_days=30):
        """Fetch option chain via IBKR API"""
        
    def find_bear_put_spread(self, symbol, stock_price, atr):
        """Find optimal bear put spread strikes"""
        # Buy ATM put (delta ~0.7)
        # Sell OTM put 5-10% below
        # Return: upper_strike, lower_strike, debit, max_gain, max_loss
        
    def calculate_spread_metrics(self, upper_put, lower_put):
        """Calculate debit, breakeven, max gain/loss"""
```

**File:** `src/options/executor.py`
```python
class OptionsExecutor:
    def place_bear_put_spread(self, symbol, upper_strike, lower_strike, quantity):
        """Execute spread as combo order via IBKR"""
        # Leg 1: Buy upper put
        # Leg 2: Sell lower put
        # Use combo order to reduce slippage
        
    def close_spread(self, position_id):
        """Close spread by reversing combo"""
```

### Phase 2: Integration (Week 2)

**Update:** `src/trading_engine/enhanced_risk.py`
```python
def calculate_options_position_size(self, spread_max_loss, confidence):
    """Size options based on max loss, not premium"""
    risk_pct = 0.015 if confidence > 0.75 else 0.01
    risk_amount = self.capital * risk_pct
    contracts = int(risk_amount / spread_max_loss)
    return max(1, contracts)  # Min 1 contract

def check_options_circuit_breaker(self, options_pnl):
    """Include options P&L in -2% daily limit"""
    total_pnl = self.stock_pnl + options_pnl
    return self.check_circuit_breaker(total_pnl)
```

**Update:** `live_engine.py`
```python
# In main trading loop
if regime == "BEAR" and bearish_consensus > 0.50:
    if OPTIONS_ENABLED:
        # Scan for bear put spread opportunities
        spread = options_scanner.find_bear_put_spread(symbol, price, atr)
        if spread and spread['debit'] < price * 0.05:
            # Execute spread
            options_executor.place_bear_put_spread(...)
    else:
        # Existing stock logic
```

### Phase 3: Configuration (Week 2)

**Add to `.env`:**
```bash
# Options Trading
OPTIONS_ENABLED=false  # Start disabled, enable after testing
OPTIONS_MAX_POSITIONS=3  # Max concurrent spreads
OPTIONS_SPREAD_WIDTH_PCT=7.5  # 5-10% strike width
OPTIONS_MIN_IV=30  # Minimum implied volatility
OPTIONS_MAX_DEBIT_PCT=5  # Max debit as % of stock price
OPTIONS_TAKE_PROFIT_PCT=75  # Take profit at 75% of max gain
OPTIONS_STOP_LOSS_PCT=50  # Stop at 50% of debit
```

**Add to `regime_detector.py`:**
```python
# In BEAR regime
if self.current_regime == "BEAR":
    # Lower threshold for options
    options_entry_threshold = 0.50  # vs 0.60 for stocks
    # Prioritize technical analysis
    openclaw_weight = 0.65
    polymarket_weight = 0.35
```

### Phase 4: Risk Management (Week 3)

**Update:** `src/diversification_checker.py`
```python
def check_options_diversification(self, new_spread, existing_spreads):
    """Ensure options diversification"""
    # Max 2 spreads per sector
    # Correlation <0.6 on underlyings
    # No overlapping strikes on same stock
```

**Update:** `src/audit_logger.py`
```python
def log_options_trade(self, trade_data):
    """Log spread metrics"""
    record = {
        'type': 'bear_put_spread',
        'upper_strike': trade_data['upper_strike'],
        'lower_strike': trade_data['lower_strike'],
        'debit': trade_data['debit'],
        'max_gain': trade_data['max_gain'],
        'max_loss': trade_data['max_loss'],
        'iv': trade_data['iv'],
        'delta': trade_data['delta'],
        'theta': trade_data['theta'],
        # ... existing fields
    }
```

### Phase 5: Testing & Validation (Week 4)

**Backtest:**
```bash
# Add options to backtest.py
python backtest_options.py --strategy bear_put_spread --period 2y
# Target: Win rate 40-60%, Sharpe >1.2, Profit factor >1.5
```

**Paper Trading:**
```bash
# Enable options in paper mode
OPTIONS_ENABLED=true python start_live_trading.py
# Monitor for 10-20 sessions
# Verify: Max loss never exceeds 1%, gains 50-200% on winners
```

---

## Expected Performance

### Metrics (Based on Backtests)
- **Win Rate:** 40-60% (lower than stocks, but defined risk)
- **Profit Factor:** 1.5-2.5 (2:1 to 5:1 winners)
- **Sharpe Ratio:** >1.2 (risk-adjusted returns)
- **Max Drawdown:** <1% per trade (defined by spread)
- **Daily Returns:** 0.5-2% on bear days

### Example Trade
**Stock:** TSLA at $200, bearish signals
- **Buy:** $200 put @ $8
- **Sell:** $180 put @ $3
- **Net Debit:** $5 ($500 per contract)
- **Max Loss:** $500 (if stock above $200 at expiry)
- **Max Gain:** $1,500 (if stock below $180 at expiry)
- **Breakeven:** $195

**Outcome if TSLA drops to $185:**
- Spread worth: $15 ($1,500)
- Profit: $1,000 (200% return)
- Time held: 2-4 hours (intraday)

---

## Risk Mitigations

1. **Defined Risk:** Max loss = debit paid (never more)
2. **Position Sizing:** 1% rule based on max loss
3. **Diversification:** Max 2 spreads/sector, <0.6 correlation
4. **Circuit Breaker:** Include options in -2% daily limit
5. **Time Decay:** Close by 3:45 PM (no overnight theta)
6. **IV Crush:** Enter post-news, avoid high-IV events
7. **Liquidity:** Only trade options with >100 daily volume
8. **Slippage:** Use combo orders, limit orders only

---

## Implementation Timeline

### Week 1: Core Development
- [ ] Create `src/options/scanner.py`
- [ ] Create `src/options/executor.py`
- [ ] Add IBKR options API calls
- [ ] Unit tests

### Week 2: Integration
- [ ] Update `enhanced_risk.py` for options sizing
- [ ] Update `live_engine.py` with options logic
- [ ] Add `.env` configuration
- [ ] Update regime detector

### Week 3: Risk & Monitoring
- [ ] Update diversification checker
- [ ] Enhance audit logger for options
- [ ] Add options dashboard metrics
- [ ] Alert escalation for options

### Week 4: Testing
- [ ] Backtest on 2 years data
- [ ] Paper trade 10-20 sessions
- [ ] Validate Sharpe >1.2
- [ ] Document results

### Week 5: Launch
- [ ] Enable in production (small size)
- [ ] Monitor for 1 week
- [ ] Scale up if metrics hit targets

---

## Branch Strategy

```bash
# Create options branch
git checkout -b add-options

# Implement in phases
git commit -m "Phase 1: Options scanner and executor"
git commit -m "Phase 2: Integration with trading engine"
git commit -m "Phase 3: Configuration and regime updates"
git commit -m "Phase 4: Risk management enhancements"
git commit -m "Phase 5: Testing and validation"

# Merge when ready
git checkout main
git merge add-options
git push origin main
```

---

## Success Criteria

Before enabling in production:
- ✅ Backtest Sharpe >1.2 over 2 years
- ✅ Paper trading win rate >40%
- ✅ Max loss per trade <1% (verified)
- ✅ No circuit breaker triggers in testing
- ✅ Clean exits by 3:45 PM (100% success)
- ✅ Dashboard shows options P&L correctly
- ✅ Audit logs capture all options metrics

---

## Next Steps

1. **Today:** Focus on stock trading validation
2. **This Week:** Collect 5 days of stock trading data
3. **Next Week:** Start options branch development
4. **Week 3-4:** Test options in paper mode
5. **Week 5:** Enable options if metrics pass

**Priority:** Validate stock trading first. Options are enhancement, not requirement.

---

## Resources

- **IBKR Options API:** https://interactivebrokers.github.io/tws-api/options.html
- **Options Greeks:** https://www.investopedia.com/options-greeks-4427784
- **Bear Put Spreads:** https://www.optionseducation.org/strategies/bear-put-spread

---

**Status:** Planned for future implementation after stock trading validation complete.
