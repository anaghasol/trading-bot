#!/bin/bash
# Monitor cron auto-start in real-time

echo "🔍 Monitoring Cron Auto-Start"
echo "=============================="
echo ""
echo "Cron will trigger at 9:25 AM ET"
echo "Current time: $(date '+%H:%M ET')"
echo ""
echo "Watching logs..."
echo ""

# Create log file if doesn't exist
touch /Users/akhilreddy/trading-bot/logs/autostart.log

# Monitor autostart log
tail -f /Users/akhilreddy/trading-bot/logs/autostart.log
