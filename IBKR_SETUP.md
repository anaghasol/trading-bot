# IBKR Setup Guide

## Quick Setup for Paper Trading

### 1. Install TWS or IB Gateway

Download from: https://www.interactivebrokers.com/en/trading/tws.php

**Choose one:**
- **TWS (Trader Workstation)** - Full trading platform with GUI
- **IB Gateway** - Lightweight API-only (recommended for bots)

### 2. Enable API Access

1. Open TWS/Gateway and login with paper trading account
2. Go to: **File → Global Configuration → API → Settings**
3. Enable:
   - ✅ Enable ActiveX and Socket Clients
   - ✅ Read-Only API (uncheck for trading)
   - ✅ Download open orders on connection
4. Set **Socket port**: `7497` (paper) or `7496` (live)
5. Add **Trusted IP**: `127.0.0.1`
6. Click **OK** and restart TWS/Gateway

### 3. Install Python Dependencies

```bash
pip install ib_insync
```

### 4. Update .env Configuration

```env
# IBKR Configuration
IBKR_HOST=127.0.0.1
IBKR_PORT=7497          # 7497 = paper, 7496 = live
IBKR_CLIENT_ID=1        # Unique ID per connection

# Paper Trading
PAPER_TRADING=true
```

### 5. Test Connection

```bash
python test_ibkr_connection.py
```

Expected output:
```
✅ Connected to IBKR on 127.0.0.1:7497
💰 Account Balance: $1,000,000.00
📊 Positions: []
```

## Port Reference

- **7497** - Paper Trading (TWS)
- **7496** - Live Trading (TWS)
- **4002** - Paper Trading (IB Gateway)
- **4001** - Live Trading (IB Gateway)

## Common Issues

### "Connection refused"
- Ensure TWS/Gateway is running
- Check API is enabled in settings
- Verify port number matches

### "Already connected"
- Only one connection per client_id
- Change IBKR_CLIENT_ID in .env
- Or disconnect previous connection

### "Not connected"
- TWS/Gateway must stay running
- Auto-reconnect on disconnect
- Check firewall settings

## Paper Trading Account

Your IBKR paper account has:
- $1,000,000 starting balance
- Real-time market data
- Full trading capabilities
- Separate from live account

## Running the Bot

Once TWS/Gateway is running:

```bash
python main.py
```

Bot will:
1. Connect to IBKR automatically
2. Start Discord + OpenClaw channels
3. Execute trades through IBKR API
4. Display trades in TWS interface

## Monitoring Trades

Trades appear in:
- TWS Activity panel
- Bot logs: `logs/trading_bot.log`
- Dashboard: `http://localhost:8080`

## Security Notes

- Paper trading is completely separate from live
- No real money at risk
- Test thoroughly before switching to live
- Keep TWS/Gateway running during bot operation
