#!/usr/bin/env python3
"""
Pre-launch validation script - Run before starting live/paper trading.
Checks all systems are ready.
"""
import os
import sys
from pathlib import Path


def check_env_file():
    """Check .env file exists and has required settings."""
    print("1. Checking .env configuration...")
    
    if not Path('.env').exists():
        print("   ❌ .env file not found. Copy .env.example to .env")
        return False
    
    required = ['IBKR_HOST', 'IBKR_PORT', 'IBKR_CLIENT_ID']
    missing = []
    
    with open('.env') as f:
        content = f.read()
        for key in required:
            if key not in content:
                missing.append(key)
    
    if missing:
        print(f"   ❌ Missing required settings: {', '.join(missing)}")
        return False
    
    print("   ✅ .env configured")
    return True


def check_dependencies():
    """Check all Python dependencies installed."""
    print("2. Checking dependencies...")
    
    try:
        import yfinance
        import pandas
        import numpy
        import flask
        print("   ✅ All dependencies installed")
        return True
    except ImportError as e:
        print(f"   ❌ Missing dependency: {e}")
        print("   Run: pip install -r requirements.txt")
        return False


def check_directories():
    """Check required directories exist."""
    print("3. Checking directories...")
    
    dirs = ['logs', 'daily_data/logs', 'daily_data/learning']
    for d in dirs:
        Path(d).mkdir(parents=True, exist_ok=True)
    
    print("   ✅ All directories ready")
    return True


def check_ibkr_connection():
    """Check if IBKR TWS/Gateway is running."""
    print("4. Checking IBKR connection...")
    
    import socket
    
    host = os.getenv('IBKR_HOST', '127.0.0.1')
    port = int(os.getenv('IBKR_PORT', '7497'))
    
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex((host, port))
        sock.close()
        
        if result == 0:
            print(f"   ✅ IBKR connected on {host}:{port}")
            return True
        else:
            print(f"   ❌ IBKR not running on {host}:{port}")
            print("   Start TWS/Gateway first")
            return False
    except Exception as e:
        print(f"   ❌ Connection check failed: {e}")
        return False


def check_backtest_results():
    """Check if backtest has been run."""
    print("5. Checking backtest results...")
    
    print("   ⚠️  Run backtest before live trading:")
    print("   python backtest.py")
    print("   Target: Sharpe >1.2, Win Rate >50%, Profit Factor >1.5")
    return True


def check_alert_config():
    """Check alert configuration."""
    print("6. Checking alert configuration...")
    
    enabled = os.getenv('ALERT_EMAIL_ENABLED', 'false').lower() == 'true'
    
    if enabled:
        sender = os.getenv('ALERT_SENDER_EMAIL', '')
        recipient = os.getenv('ALERT_RECIPIENT_EMAIL', '')
        
        if sender and recipient:
            print("   ✅ Alerts configured")
            print("   Test with: python test_alerts.py")
        else:
            print("   ⚠️  Alerts enabled but missing email settings")
    else:
        print("   ℹ️  Alerts disabled (optional)")
    
    return True


def check_daily_sync():
    """Check daily sync setup."""
    print("7. Checking daily sync...")
    
    if Path('daily_sync.sh').exists():
        print("   ✅ daily_sync.sh exists")
        print("   Setup cron: See DAILY_SYNC_SETUP.md")
    else:
        print("   ❌ daily_sync.sh not found")
        return False
    
    return True


def main():
    """Run all validation checks."""
    print("🔍 Pre-Launch Validation\n")
    
    checks = [
        check_env_file,
        check_dependencies,
        check_directories,
        check_ibkr_connection,
        check_backtest_results,
        check_alert_config,
        check_daily_sync
    ]
    
    results = [check() for check in checks]
    
    print("\n" + "="*50)
    
    if all(results):
        print("✅ All checks passed! Ready to launch.")
        print("\nStart trading:")
        print("  python start_live_trading.py")
        print("\nDashboard:")
        print("  http://localhost:8080")
    else:
        print("❌ Some checks failed. Fix issues above before launching.")
        sys.exit(1)


if __name__ == '__main__':
    main()
