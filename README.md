# Live Trading Bot - OpenClaw + Polymarket

Smart automated trading bot using dual validation:
- **OpenClaw**: Technical analysis (trend, momentum, volatility)
- **Polymarket**: Crowd prediction markets (sentiment, probability)

## Quick Start

### 1. Prerequisites
- Python 3.9+
- IBKR Trader Workstation (TWS) or Gateway running
- Port 7497 (paper) or 7496 (live)

### 2. Install
```bash
pip install -r requirements.txt
```

### 3. Configure
Edit `src/config.py`:
```python
IBKR_HOST = "127.0.0.1"
IBKR_PORT = 7497  # Paper trading
IBKR_CLIENT_ID = 1
```

### 4. Run
```bash
# Start bot
python live_engine.py

# Or with dashboard
python start_live_trading.py
```

Dashboard: http://localhost:8080

## How It Works

### Professional Features

✅ **Regime Detection** - Adapts to bull/bear/flat markets  
✅ **ATR-Based Stops** - Dynamic 2x ATR stops (not fixed %)  
✅ **1% Position Sizing** - Never risk >1% per trade  
✅ **Circuit Breaker** - Auto-stop at -2% daily loss  
✅ **Volume Filter** - Only trade 2x average volume  
✅ **Diversification** - Max 2 per sector, <0.6 correlation  
✅ **Fallback Handler** - Works if Polymarket/OpenClaw fails  
✅ **News Monitor** - Pauses 30min around economic events  
✅ **Alert Escalation** - Email/SMS on critical issues  
✅ **ML-Lite** - Auto-adjusts weights based on 7-day accuracy  
✅ **Backtesting** - Sharpe >1.2 validation with slippage  

### Trading Hours
- **9:30 AM - 3:45 PM ET**: Active trading
- **3:45 PM**: Close all positions
- **4:00 PM**: Bot auto-shutdown

### Every 90 Seconds

1. **Detect Regime** - Classify market (bull/bear/flat)
2. **Scan** 10 trending stocks with 2x volume
3. **Update** existing positions with ATR stops
4. **Analyze** new opportunities:
   - OpenClaw technical analysis (60-70% adaptive)
   - Polymarket crowd sentiment (30-40% adaptive)
   - Trade only if BOTH agree (>55% each)
5. **Execute** trades with 1% position sizing
6. **Monitor** circuit breaker and latency

### Exit Strategy

**ATR-Based Stops:**
- Stop: Entry - (2x ATR)
- Target: Entry + (3x ATR) for 2:1 reward:risk

**Circuit Breaker:**
- Auto-stop all trading at -2% daily loss

**Trailing Stop:**
- Peak 2%+ → don't drop below 1%

**Trend Reversal:**
- Trend < 45% → exit before loss

**Time-Based:**
- Close all positions at 3:45 PM ET

## Files

### Core
- `live_engine.py` - Main trading engine
- `start_live_trading.py` - Start with dashboard
- `dashboard.py` - Web dashboard
- `trading_state.json` - Current state

### Source
- `src/ibkr_client/` - IBKR API integration
- `src/openclaw_agent/` - Technical analysis
- `src/polymarket_client/` - Prediction markets
- `src/market_scanner/` - Trending stock scanner
- `src/trading_engine/` - Trade execution & risk
- `src/strategy/` - Exit strategies
- `src/regime_detector.py` - Market regime detection
- `src/alert_escalation.py` - Email/SMS alerts
- `src/fallback_handler.py` - Dependency fallback
- `src/diversification_checker.py` - Sector/correlation limits
- `src/news_monitor.py` - Economic event pauses
- `src/latency_monitor.py` - Performance tracking
- `src/audit_logger.py` - Enhanced trade logging
- `src/config.py` - Configuration

### Logs
- `logs/trading_bot.log` - Execution log
- `logs/audit_YYYY-MM-DD.jsonl` - Detailed trade metrics
- `logs/summary_YYYY-MM-DD.json` - Daily summaries
- `logs/daily_profits_YYYY-MM-DD.txt` - Daily P&L

### Validation
- `backtest.py` - Historical backtesting with slippage
- `LAUNCH_CHECKLIST.md` - Pre-launch validation steps

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# IBKR Connection
IBKR_HOST=127.0.0.1
IBKR_PORT=7497  # 7497=paper, 7496=live
IBKR_CLIENT_ID=1

# Risk Management
MAX_DAILY_LOSS_PERCENT=2.0  # Circuit breaker
MAX_POSITION_SIZE_PERCENT=1.0  # 1% rule
ATR_STOP_MULTIPLIER=2.0
ATR_TARGET_MULTIPLIER=3.0

# Filters
MIN_VOLUME_MULTIPLIER=2.0  # 2x average volume
MAX_POSITIONS_PER_SECTOR=2
MAX_CORRELATION=0.6

# Alerts (optional)
ALERT_EMAIL_ENABLED=false
ALERT_RECIPIENT_EMAIL=your@email.com
```

## Validation

### Before Live Trading

1. **Backtest** (6 months historical):
```bash
python backtest.py
```
Target: Sharpe >1.2, Win Rate >50%, Profit Factor >1.5

2. **Paper Trade** (10-20 sessions):
- Monitor dashboard daily
- Verify circuit breaker works
- Check clean shutdown at 4 PM
- Review audit logs

3. **Launch Checklist**:
See [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) for complete validation.

## Daily Flow

See [DAILY_FLOW.md](DAILY_FLOW.md) for complete flow.

## Strategy

See [SMART_EXIT_STRATEGY.md](SMART_EXIT_STRATEGY.md) for exit rules.

## Disclaimer

⚠️ **Paper trading recommended**. Use at your own risk.
