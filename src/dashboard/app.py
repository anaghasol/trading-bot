"""
Flask dashboard for real-time trading bot monitoring.
Runs on localhost:5000
"""

import json
import threading
from datetime import datetime
from flask import Flask, render_template, jsonify
from src.utils import logger
from src.config import settings


class TradingDashboard:
    """Flask app for monitoring trading bot."""

    def __init__(self):
        self.app = Flask(__name__, template_folder='templates', static_folder='static')
        self.trade_executor = None
        self.risk_manager = None
        self.setup_routes()
        logger.info("📊 Trading Dashboard initialized")

    def setup_routes(self):
        """Register Flask routes."""

        @self.app.route('/')
        def dashboard():
            """Main dashboard page."""
            return render_template('dashboard.html')

        @self.app.route('/api/account')
        def api_account():
            """Get account balance and info."""
            try:
                if not self.trade_executor or not self.trade_executor.schwab_client:
                    return jsonify({
                        "balance": 0,
                        "cash": 0,
                        "paper_trading": settings.paper_trading,
                        "account_id": settings.schwab_account_id[:8] + "..."
                    })

                balance_info = self.trade_executor.schwab_client.get_account_balance()
                return jsonify({
                    "balance": balance_info.get("total_account_value", 0),
                    "cash": balance_info.get("cash_available", 0),
                    "buying_power": balance_info.get("buying_power", 0),
                    "paper_trading": settings.paper_trading,
                    "account_id": settings.schwab_account_id[:8] + "...",
                    "position_size_percent": settings.max_position_size_percent
                })
            except Exception as e:
                logger.error(f"Error fetching account info: {e}")
                return jsonify({"error": str(e)}), 500

        @self.app.route('/api/positions')
        def api_positions():
            """Get active positions with real-time P&L from IBKR."""
            try:
                if not self.trade_executor or not self.trade_executor.ibkr_client:
                    return jsonify({"positions": [], "total_pnl": 0})

                # Get real positions from IBKR with P&L
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                ibkr_positions = loop.run_until_complete(
                    self.trade_executor.ibkr_client.get_positions()
                )
                loop.close()

                positions = []
                total_pnl = 0
                
                for pos in ibkr_positions:
                    pnl = pos.get("unrealized_pnl", 0)
                    total_pnl += pnl
                    
                    positions.append({
                        "symbol": pos.get("symbol"),
                        "quantity": pos.get("quantity", 0),
                        "avg_cost": pos.get("avg_cost", 0),
                        "current_price": pos.get("current_price", 0),
                        "market_value": pos.get("market_value", 0),
                        "unrealized_pnl": pnl,
                        "contract_type": pos.get("contract_type", "STOCK"),
                        "strike": pos.get("strike"),
                        "right": pos.get("right"),
                        "expiration": pos.get("expiration")
                    })

                return jsonify({"positions": positions, "total_pnl": total_pnl})
            except Exception as e:
                logger.error(f"Error fetching positions: {e}")
                return jsonify({"positions": [], "total_pnl": 0}), 500

        @self.app.route('/api/trades')
        def api_trades():
            """Get ALL trade history (not just last 20)."""
            try:
                if not self.trade_executor:
                    return jsonify({"trades": []})

                trades = []
                # Get ALL executed trades, not just last 20
                executed_trades = list(self.trade_executor.executed_trades.items())

                for trade_id, trade_data in executed_trades:
                    trades.append({
                        "trade_id": trade_id,
                        "symbol": trade_data.get("symbol"),
                        "action": trade_data.get("action"),
                        "price": trade_data.get("price", 0),
                        "quantity": trade_data.get("quantity", 0),
                        "timestamp": trade_data.get("timestamp", ""),
                        "status": trade_data.get("status", "executed"),
                        "confidence": trade_data.get("confidence", 0),
                        "pnl": trade_data.get("pnl"),
                        "executed_at": trade_data.get("executed_at", "")
                    })

                return jsonify({"trades": trades, "total_count": len(trades)})
            except Exception as e:
                logger.error(f"Error fetching trade history: {e}")
                return jsonify({"trades": [], "total_count": 0}), 500

        @self.app.route('/api/risk-metrics')
        def api_risk_metrics():
            """Get risk metrics."""
            try:
                if not self.trade_executor or not self.trade_executor.risk_manager:
                    return jsonify({
                        "active_trades": 0,
                        "max_concurrent": settings.max_concurrent_trades,
                        "position_size_percent": settings.max_position_size_percent,
                        "stop_loss_percent": settings.stop_loss_percent,
                        "trailing_stop_percent": settings.trailing_stop_percent
                    })

                active_count = self.trade_executor.risk_manager.get_active_positions_count()
                max_trades = self.trade_executor.risk_manager.get_random_concurrent_trades()

                return jsonify({
                    "active_trades": active_count,
                    "max_concurrent": max_trades,
                    "position_size_percent": settings.max_position_size_percent,
                    "stop_loss_percent": settings.stop_loss_percent,
                    "trailing_stop_percent": settings.trailing_stop_percent,
                    "can_trade": active_count < max_trades
                })
            except Exception as e:
                logger.error(f"Error fetching risk metrics: {e}")
                return jsonify({"error": str(e)}), 500

        @self.app.route('/api/logs')
        def api_logs():
            """Get recent logs."""
            try:
                with open(settings.log_file_path, 'r') as f:
                    all_logs = f.readlines()
                    recent_logs = all_logs[-50:]  # Last 50 lines
                    return jsonify({
                        "logs": [log.strip() for log in recent_logs if log.strip()]
                    })
            except FileNotFoundError:
                return jsonify({"logs": []})
            except Exception as e:
                logger.error(f"Error reading logs: {e}")
                return jsonify({"logs": []}), 500

        @self.app.route('/api/status')
        def api_status():
            """Get overall bot status."""
            return jsonify({
                "status": "running",
                "paper_trading": settings.paper_trading,
                "timestamp": datetime.now().isoformat(),
                "version": "1.0.0"
            })

    def run(self, port=5000, debug=False):
        """Run the Flask app."""
        logger.info(f"🌐 Dashboard starting on http://localhost:{port}")
        self.app.run(host='127.0.0.1', port=port, debug=debug, use_reloader=False)

    def inject_dependencies(self, trade_executor, risk_manager):
        """Inject trading engine dependencies."""
        self.trade_executor = trade_executor
        self.risk_manager = risk_manager


# Global dashboard instance
dashboard = TradingDashboard()


def start_dashboard(trade_executor, risk_manager, port=5000):
    """Start dashboard in background thread."""
    dashboard.inject_dependencies(trade_executor, risk_manager)
    
    def run_server():
        dashboard.run(port=port, debug=False)
    
    thread = threading.Thread(target=run_server, daemon=True)
    thread.start()
    logger.info(f"✅ Dashboard thread started - Visit http://localhost:{port}")
    return thread
