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

### Trading Hours
- **9:30 AM - 3:45 PM ET**: Active trading
- **3:45 PM**: Close all positions
- **4:00 PM**: Bot auto-shutdown

### Every 90 Seconds

1. **Scan** 10 trending stocks
2. **Update** existing positions
3. **Analyze** new opportunities:
   - OpenClaw technical analysis (60%)
   - Polymarket crowd sentiment (40%)
   - Trade only if BOTH agree (>55% each)
4. **Execute** trades with consensus

### Exit Strategy

**Stop-Loss:**
- Stocks: -1%
- Options: -2%

**Take-Profit:**
- Stocks: +1.5%
- Options: +3%

**Trailing Stop:**
- Peak 2%+ → don't drop below 1%

**Trend Reversal:**
- Trend < 45% → exit before loss

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
- `src/config.py` - Configuration

### Logs
- `logs/trading_bot.log` - Execution log
- `logs/daily_profits_YYYY-MM-DD.txt` - Daily P&L

## Configuration

Edit `src/config.py`:

```python
# IBKR Connection
IBKR_HOST = "127.0.0.1"
IBKR_PORT = 7497  # 7497=paper, 7496=live
IBKR_CLIENT_ID = 1

# Risk Management
STOP_LOSS_STOCK = 1.0      # -1%
STOP_LOSS_OPTION = 2.0     # -2%
TAKE_PROFIT_STOCK = 1.5    # +1.5%
TAKE_PROFIT_OPTION = 3.0   # +3%

# Position Sizing
MAX_POSITIONS = 8
POSITION_SIZE_PCT = 12     # 12% per position
```

## Daily Flow

See [DAILY_FLOW.md](DAILY_FLOW.md) for complete flow.

## Strategy

See [SMART_EXIT_STRATEGY.md](SMART_EXIT_STRATEGY.md) for exit rules.

## Disclaimer

⚠️ **Paper trading recommended**. Use at your own risk.
