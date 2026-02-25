# Automated Trading Bot - Cron Setup

## Overview
Automatically start trading bot at 9:25 AM ET every weekday (Mon-Fri).

## Setup Instructions

### 1. Make scripts executable (already done)
```bash
chmod +x /Users/akhilreddy/trading-bot/auto_start.sh
chmod +x /Users/akhilreddy/trading-bot/daily_sync.sh
```

### 2. Edit crontab
```bash
crontab -e
```

### 3. Add these lines
```bash
# Auto-start trading bot at 9:25 AM ET (Mon-Fri)
25 9 * * 1-5 /Users/akhilreddy/trading-bot/auto_start.sh

# Daily sync at 4:30 PM ET (Mon-Fri) - after market close
30 16 * * 1-5 cd /Users/akhilreddy/trading-bot && ./daily_sync.sh >> logs/daily_sync.log 2>&1
```

**Important:** These times assume your system clock is set to ET (Eastern Time).

### 4. Verify cron jobs
```bash
crontab -l
```

Should show:
```
25 9 * * 1-5 /Users/akhilreddy/trading-bot/auto_start.sh
30 16 * * 1-5 cd /Users/akhilreddy/trading-bot && ./daily_sync.sh >> logs/daily_sync.log 2>&1
```

---

## What Happens Automatically

### 9:25 AM ET (Mon-Fri)
1. Cron triggers `auto_start.sh`
2. Script checks if IBKR is running (port 7497)
3. If IBKR ready, starts trading bot
4. Bot runs until 4:00 PM ET (auto-shutdown)
5. Logs to `logs/autostart.log`

### 4:30 PM ET (Mon-Fri)
1. Cron triggers `daily_sync.sh`
2. Copies today's logs to `daily_data/`
3. Commits and pushes to GitHub
4. Cleans up logs older than 30 days

---

## Prerequisites

### IBKR Must Be Running
**Critical:** IBKR TWS/Gateway must be running BEFORE 9:25 AM.

**Option 1: Manual Start (Recommended for now)**
- Open IBKR TWS/Gateway at 9:00 AM
- Let cron auto-start bot at 9:25 AM

**Option 2: Auto-start IBKR (Advanced)**
- Use AppleScript or Automator to launch IBKR at 9:00 AM
- See IBKR_AUTO_START.md (create if needed)

---

## Testing

### Test Auto-Start Manually
```bash
./auto_start.sh
```

Should see in `logs/autostart.log`:
```
========================================
Wed Feb 25 09:25:00 EST 2026: Auto-start triggered
Wed Feb 25 09:25:01 EST 2026: Starting trading bot...
Wed Feb 25 09:25:02 EST 2026: Bot started with PID 12345
Dashboard: http://localhost:8080
```

### Test Daily Sync
```bash
./daily_sync.sh
```

Should see:
```
📦 Syncing daily data for 2026-02-25...
✅ Daily data synced to GitHub
🧹 Cleaned up logs older than 30 days
```

---

## Monitoring

### Check if bot is running
```bash
ps aux | grep start_live_trading.py
```

### View auto-start logs
```bash
tail -f logs/autostart.log
```

### View trading logs
```bash
tail -f logs/trading_bot.log
```

### Check dashboard
```
http://localhost:8080
```

---

## Troubleshooting

### Bot didn't start at 9:25 AM

**Check cron logs:**
```bash
tail -20 logs/autostart.log
```

**Common issues:**
1. IBKR not running → Start TWS/Gateway before 9:25 AM
2. Wrong timezone → Verify system time matches ET
3. Cron not running → Check `crontab -l`

### Bot started but crashed

**Check trading logs:**
```bash
tail -50 logs/trading_bot.log
```

**Common issues:**
1. Missing dependencies → Run `pip3 install -r requirements.txt`
2. IBKR connection lost → Restart TWS/Gateway
3. Port conflict → Check if port 8080 is free

---

## Manual Override

### Start bot manually (skip cron)
```bash
python3 start_live_trading.py
```

### Stop bot
```bash
pkill -f start_live_trading.py
```

### Disable cron temporarily
```bash
crontab -e
# Comment out lines with #
# 25 9 * * 1-5 /Users/akhilreddy/trading-bot/auto_start.sh
```

---

## Daily Routine (Fully Automated)

### Your Tasks
1. **9:00 AM** - Start IBKR TWS/Gateway (manual)
2. **9:30 AM** - Check dashboard to verify bot started
3. **4:05 PM** - Verify bot shutdown cleanly
4. **End of day** - Review logs (optional)

### Automated Tasks
- **9:25 AM** - Bot auto-starts
- **9:30-3:45 PM** - Active trading
- **3:45 PM** - Close all positions
- **4:00 PM** - Bot auto-shutdown
- **4:30 PM** - Sync logs to GitHub

---

## Next Steps

1. ✅ Run `crontab -e` and add the two lines above
2. ✅ Test manually: `./auto_start.sh`
3. ✅ Start IBKR at 9:00 AM tomorrow
4. ✅ Verify bot auto-starts at 9:25 AM
5. ✅ Monitor dashboard throughout the day
6. ✅ Check logs at end of day

**After 1 week of successful automated trading, consider auto-starting IBKR too.**
