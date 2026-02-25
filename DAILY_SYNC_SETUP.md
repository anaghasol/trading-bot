# Automatic Daily Sync Setup

## Overview
Automatically push daily logs and learning data to GitHub at 4:30 PM ET (after market close).

## Setup Instructions

### 1. Make script executable (already done)
```bash
chmod +x daily_sync.sh
```

### 2. Add to crontab
```bash
crontab -e
```

### 3. Add this line (4:30 PM ET = 21:30 UTC in winter, 20:30 UTC in summer)
```bash
# Daily sync at 4:30 PM ET (adjust for your timezone)
30 16 * * 1-5 cd /Users/akhilreddy/trading-bot && ./daily_sync.sh >> logs/daily_sync.log 2>&1
```

**Note:** Adjust time based on your timezone:
- EST (winter): 4:30 PM = 16:30 local
- EDT (summer): 4:30 PM = 16:30 local
- PST: 1:30 PM = 13:30 local
- CST: 3:30 PM = 15:30 local

### 4. Verify cron job
```bash
crontab -l
```

## Manual Sync
Run anytime:
```bash
./daily_sync.sh
```

## What Gets Synced

### Daily Logs (daily_data/logs/)
- `audit_YYYY-MM-DD.jsonl` - Detailed trade metrics
- `summary_YYYY-MM-DD.json` - Daily summary stats
- `daily_profits_YYYY-MM-DD.txt` - P&L breakdown

### Learning Data (daily_data/learning/)
- `ml_weights_YYYY-MM-DD.json` - ML-lite weight adjustments
- Performance metrics for regime detection

## Local Cleanup
- Keeps last 30 days locally
- All data preserved in GitHub forever
- Prevents disk space issues

## Troubleshooting

### Cron not running?
Check cron logs:
```bash
tail -f logs/daily_sync.log
```

### Permission issues?
Ensure Git credentials cached:
```bash
git config --global credential.helper osxkeychain
```

### Test manually first
```bash
./daily_sync.sh
```
Should see "✅ Daily data synced to GitHub"
