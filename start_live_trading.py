#!/usr/bin/env python3
"""
Start Live Trading Bot + Dashboard
"""
import asyncio
import sys
from threading import Thread
from dashboard import app, start_dashboard
from live_engine import start_trading_engine

def run_dashboard():
    """Run Flask dashboard"""
    print("📊 Starting dashboard on http://localhost:8080")
    app.run(host='0.0.0.0', port=8080, debug=False, use_reloader=False)

async def main():
    """Start both trading engine and dashboard"""
    print("=" * 80)
    print("🚀 LIVE TRADING BOT")
    print("=" * 80)
    print()
    print("📊 Dashboard: http://localhost:8080")
    print("💰 Starting Balance: $1,000,000")
    print("🎯 Strategy: Aggressive trading with 60%+ confidence")
    print("📈 Max Positions: 8 (up from 5)")
    print("📊 Watchlist: 25 stocks")
    print("⚡ Exit: +3% profit or -2% loss (fast rotation)")
    print("⏱️  Scan Frequency: Every 20 seconds")
    print()
    print("=" * 80)
    print()
    
    # Start dashboard in background thread
    dashboard_thread = Thread(target=run_dashboard, daemon=True)
    dashboard_thread.start()
    
    # Wait a moment for dashboard to start
    await asyncio.sleep(2)
    
    # Start trading engine (main loop)
    await start_trading_engine()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Trading bot stopped")
        sys.exit(0)
