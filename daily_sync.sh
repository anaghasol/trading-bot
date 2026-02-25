#!/bin/bash
# Daily sync script - automatically push logs and learning data to GitHub
# Run this at end of trading day (4:30 PM ET) via cron

DATE=$(date +%Y-%m-%d)
REPO_DIR="/Users/akhilreddy/trading-bot"

cd "$REPO_DIR" || exit 1

echo "📦 Syncing daily data for $DATE..."

# Copy today's logs to daily_data
cp -f logs/audit_${DATE}.jsonl daily_data/logs/ 2>/dev/null || true
cp -f logs/summary_${DATE}.json daily_data/logs/ 2>/dev/null || true
cp -f logs/daily_profits_${DATE}.txt daily_data/logs/ 2>/dev/null || true

# Copy learning data (ML-lite metrics)
if [ -f "logs/ml_weights_${DATE}.json" ]; then
    cp -f logs/ml_weights_${DATE}.json daily_data/learning/
fi

# Commit and push
git add daily_data/
git commit -m "Daily sync: Logs and learning data for $DATE" 2>/dev/null

if [ $? -eq 0 ]; then
    git push origin main
    echo "✅ Daily data synced to GitHub"
else
    echo "ℹ️  No new data to sync"
fi

# Cleanup old logs (keep last 30 days locally)
find logs/ -name "audit_*.jsonl" -mtime +30 -delete
find logs/ -name "summary_*.json" -mtime +30 -delete
find logs/ -name "daily_profits_*.txt" -mtime +30 -delete

echo "🧹 Cleaned up logs older than 30 days"
