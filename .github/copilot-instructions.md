# Trading Bot - Copilot Instructions

## Project Overview
Discord-driven automated trading bot that:
- Listens to trade alerts on Discord
- Parses stock and options trading signals
- Executes on Schwab with intelligent risk management
- Supports paper trading and live trading

## Key Features
- **Discord Integration**: Real-time trade alert parsing
- **Schwab API**: OAuth2 auth, stock & options trading
- **Risk Management**: Stop loss (3%), trailing stops (15%), position sizing (80%)
- **Logging**: Comprehensive trade execution logging for 10-day testing
- **Concurrent Trade Management**: 2-5 random concurrent trades

## Project Structure
```
src/
  ├── discord_client/     # Discord bot listener and parser
  ├── schwab_client/      # Schwab API client & OAuth2
  ├── trading_engine/     # Trade execution & risk management
  ├── utils/              # Logger and utilities
  └── config.py           # Configuration management
```

## Technology Stack
- **Python 3.9+**
- **discord.py** - Discord bot framework
- **requests** - HTTP client for APIs
- **pydantic** - Configuration validation
- **asyncio** - Async/await support

## Getting Started

### 1. Prerequisites
- Python 3.9+
- Schwab API credentials (developer.schwab.com)
- Discord bot token
- Discord channel for trade alerts

### 2. Setup
```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### 3. Configuration
Edit `.env` with:
- Discord token and channel ID
- Schwab API credentials
- Risk management settings

### 4. Schwab OAuth Setup
1. Visit [developer.schwab.com/apps](https://developer.schwab.com)
2. Create OAuth Application
3. Get Client ID & Secret
4. Set Redirect URI: `http://localhost:8000/callback`

### 5. Run
```bash
python main.py
```

## Key Components

### Discord Bot (`discord_client/discord_bot.py`)
- Listens to configured channel
- Parses trade alerts (BUY/SELL/BTO/STO format)
- Extracts: symbol, action, price, stop loss, target
- Triggers trade callback

### Schwab Client (`schwab_client/`)
- **auth.py**: OAuth2 authentication and token management
- **client.py**: Place orders, get account balance, manage positions

### Trade Executor (`trading_engine/trade_executor.py`)
- Validates trade signals
- Calculates position sizing
- Executes stock and options trades
- Manages trade lifecycle

### Risk Manager (`trading_engine/risk_manager.py`)
- Calculates stop losses (3% default)
- Manages trailing stops (15% activation)
- Position sizing (80% max)
- Concurrent trade limiting

## Development Notes

### Trade Alert Parsing
Messages are parsed with regex to extract:
```
BUY AAPL at $150 (stop loss $145, target $160)
STO 2/27 $680p FILLED AT: $1.00 debit
```

### Risk Management Flow
1. Alert received → Validated
2. Check concurrent trade limit
3. Get account balance
4. Calculate position size
5. Place order with stop loss
6. Register position for monitoring
7. Update on price changes
8. Execute trailing stops

### Logging
All trades logged to `logs/trading_bot.log`:
- Timestamp
- Action (BUY/SELL/BTO/STO)
- Symbol
- Price & stop loss
- Position size
- Account balance

## Configuration Options
```env
# Risk Management (configurable in src/config.py)
STOP_LOSS_PERCENT=3
TRAILING_STOP_PERCENT=15
MAX_POSITION_SIZE_PERCENT=80
MIN_CONCURRENT_TRADES=2
MAX_CONCURRENT_TRADES=5

# Trading Modes
PAPER_TRADING=true
ENABLE_PAPER_MONEY=true
```

## Testing (10-Day Paper Trading)
1. Ensure `PAPER_TRADING=true` and `ENABLE_PAPER_MONEY=true`
2. Post test trade alerts to Discord channel
3. Bot will parse and execute on Schwab paperMoney
4. Monitor `logs/trading_bot.log` for executions
5. Adjust settings based on results
6. Switch to live trading when ready

## Common Tasks

### Add New Trade Signal Type
Edit `discord_client/discord_bot.py` - `parse_trade_alert()`

### Adjust Risk Settings
Modify `src/config.py` or `.env` file

### Monitor Active Trades
Call `executor.get_active_trades()`

### Debug Trade Execution
Check `logs/trading_bot.log` for detailed logs

## Error Handling
- API failures logged and caught
- Invalid trade data validated before execution
- Position limits enforced
- Account balance checked before trades
- Graceful error recovery

## Security Notes
- Store `.env` file safely (not in git)
- Rotate Schwab tokens periodically
- Use Discord bot token securely
- Enable OAuth scopes minimally
- Log sensitive data carefully

## Performance Notes
- Async Discord listener (non-blocking)
- Efficient trade parsing with regex
- Rate limiting handled by APIs
- Position cache in memory
- No database needed for 10-day testing

## Next Steps for User
1. ✅ Get Schwab API credentials
2. ✅ Get Discord bot token
3. ✅ Configure `.env`
4. ✅ Run `python main.py`
5. ✅ Test with paper money for 10 days
6. Optional: Create GitHub repo & tweets/tutorials

## Resources
- [Schwab Developer Docs](https://developer.schwab.com/docs)
- [Discord.py Documentation](https://discordpy.readthedocs.io)
- [Python AsyncIO](https://docs.python.org/3/library/asyncio.html)

---
**Version**: 1.0.0  
**Created**: February 2026  
**Status**: Ready for testing
