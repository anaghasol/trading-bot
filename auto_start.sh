#!/bin/bash
# Auto-start trading bot at 9:25 AM ET on weekdays
# This script is triggered by cron

REPO_DIR="/Users/akhilreddy/trading-bot"
LOG_FILE="$REPO_DIR/logs/autostart.log"

cd "$REPO_DIR" || exit 1

echo "========================================" >> "$LOG_FILE"
echo "$(date): Auto-start triggered" >> "$LOG_FILE"

# Check if IBKR is running
if ! nc -z 127.0.0.1 7497 2>/dev/null; then
    echo "$(date): ERROR - IBKR not running on port 7497" >> "$LOG_FILE"
    echo "Start IBKR TWS/Gateway first!" >> "$LOG_FILE"
    exit 1
fi

# Check if bot already running
if pgrep -f "start_live_trading.py" > /dev/null; then
    echo "$(date): Bot already running, skipping" >> "$LOG_FILE"
    exit 0
fi

# Start the bot in background
echo "$(date): Starting trading bot..." >> "$LOG_FILE"
nohup /usr/bin/python3 "$REPO_DIR/start_live_trading.py" >> "$LOG_FILE" 2>&1 &

echo "$(date): Bot started with PID $!" >> "$LOG_FILE"
echo "Dashboard: http://localhost:8080" >> "$LOG_FILE"
