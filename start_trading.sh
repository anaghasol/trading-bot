#!/bin/bash
# Quick start script for trading bot
# Run this at 9:25 AM ET (5 minutes before market open)

echo "🚀 Starting Trading Bot..."
echo ""

# Check time
python3 -c "
from datetime import datetime
import pytz
et = pytz.timezone('America/New_York')
now = datetime.now(et)
hour = now.hour
minute = now.minute

if hour < 9 or (hour == 9 and minute < 25):
    print('⚠️  Too early! Start at 9:25 AM ET')
    exit(1)
elif hour >= 16:
    print('⚠️  Market closed! Come back tomorrow')
    exit(1)
else:
    print(f'✅ Good timing! Current time: {now.strftime(\"%H:%M ET\")}')
"

if [ $? -ne 0 ]; then
    exit 1
fi

echo ""
echo "Starting bot with dashboard..."
echo "Dashboard will be available at: http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Start the bot
cd /Users/akhilreddy/trading-bot
python3 start_live_trading.py
