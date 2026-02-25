#!/usr/bin/env python3
"""AI Learning Engine - Learns from trades to maximize profits"""
import json
import os
from datetime import datetime, timedelta
from collections import defaultdict

class TradingLearningEngine:
    """Learns from every trade to improve future performance"""
    
    def __init__(self):
        self.trades_db = "logs/trades_history.json"
        self.learning_db = "logs/learning_insights.json"
        self.daily_archive = "logs/daily_archives/"
        os.makedirs(self.daily_archive, exist_ok=True)
        
        self.trades = self._load_trades()
        self.insights = self._load_insights()
    
    def _load_trades(self):
        if os.path.exists(self.trades_db):
            with open(self.trades_db, 'r') as f:
                return json.load(f)
        return []
    
    def _load_insights(self):
        if os.path.exists(self.learning_db):
            with open(self.learning_db, 'r') as f:
                return json.load(f)
        return {
            "best_entry_times": {},
            "best_exit_signals": {},
            "symbol_win_rates": {},
            "optimal_hold_times": {},
            "polymarket_accuracy": {},
            "openclaw_accuracy": {}
        }
    
    def record_trade(self, trade_data):
        """Record every trade with full details"""
        trade = {
            "timestamp": datetime.now().isoformat(),
            "symbol": trade_data["symbol"],
            "action": trade_data["action"],
            "entry_price": trade_data["entry_price"],
            "exit_price": trade_data.get("exit_price"),
            "profit_pct": trade_data.get("profit_pct"),
            "hold_time_minutes": trade_data.get("hold_time_minutes"),
            "confidence": trade_data["confidence"],
            "polymarket_score": trade_data.get("polymarket_score"),
            "openclaw_score": trade_data.get("openclaw_score"),
            "entry_hour": datetime.now().hour,
            "exit_reason": trade_data.get("exit_reason"),  # "target", "stop_loss", "trailing_stop"
            "success": trade_data.get("profit_pct", 0) > 0
        }
        self.trades.append(trade)
        self._save_trades()
        
        # Learn from this trade
        if trade.get("exit_price"):
            self._learn_from_trade(trade)
    
    def _learn_from_trade(self, trade):
        """Extract insights from completed trade"""
        symbol = trade["symbol"]
        
        # Learn best entry times
        if trade["success"]:
            hour = trade["entry_hour"]
            if symbol not in self.insights["best_entry_times"]:
                self.insights["best_entry_times"][symbol] = defaultdict(int)
            self.insights["best_entry_times"][symbol][str(hour)] += 1
        
        # Learn optimal hold times
        if trade["success"] and trade.get("hold_time_minutes"):
            if symbol not in self.insights["optimal_hold_times"]:
                self.insights["optimal_hold_times"][symbol] = []
            self.insights["optimal_hold_times"][symbol].append(trade["hold_time_minutes"])
        
        # Track symbol win rates
        if symbol not in self.insights["symbol_win_rates"]:
            self.insights["symbol_win_rates"][symbol] = {"wins": 0, "losses": 0}
        
        if trade["success"]:
            self.insights["symbol_win_rates"][symbol]["wins"] += 1
        else:
            self.insights["symbol_win_rates"][symbol]["losses"] += 1
        
        # Learn Polymarket accuracy
        if trade.get("polymarket_score"):
            score_bucket = int(trade["polymarket_score"] * 10) / 10
            if str(score_bucket) not in self.insights["polymarket_accuracy"]:
                self.insights["polymarket_accuracy"][str(score_bucket)] = {"correct": 0, "total": 0}
            
            self.insights["polymarket_accuracy"][str(score_bucket)]["total"] += 1
            if trade["success"]:
                self.insights["polymarket_accuracy"][str(score_bucket)]["correct"] += 1
        
        self._save_insights()
    
    def should_enter_trade(self, symbol, confidence, polymarket_score, current_hour):
        """AI decides if we should enter based on learned patterns"""
        # Check symbol win rate
        if symbol in self.insights["symbol_win_rates"]:
            stats = self.insights["symbol_win_rates"][symbol]
            total = stats["wins"] + stats["losses"]
            if total > 5:  # Need at least 5 trades to learn
                win_rate = stats["wins"] / total
                if win_rate < 0.4:  # Less than 40% win rate
                    return False, "Low historical win rate"
        
        # Check if this is a good entry time
        if symbol in self.insights["best_entry_times"]:
            best_hours = self.insights["best_entry_times"][symbol]
            if str(current_hour) not in best_hours and len(best_hours) > 3:
                return False, "Not optimal entry time based on history"
        
        # Check Polymarket accuracy
        score_bucket = int(polymarket_score * 10) / 10
        if str(score_bucket) in self.insights["polymarket_accuracy"]:
            pm_stats = self.insights["polymarket_accuracy"][str(score_bucket)]
            if pm_stats["total"] > 5:
                pm_accuracy = pm_stats["correct"] / pm_stats["total"]
                if pm_accuracy < 0.5:
                    return False, "Polymarket historically inaccurate at this confidence"
        
        return True, "All checks passed"
    
    def get_optimal_exit_time(self, symbol):
        """Suggest when to exit based on learned patterns"""
        if symbol in self.insights["optimal_hold_times"]:
            hold_times = self.insights["optimal_hold_times"][symbol]
            if len(hold_times) > 3:
                avg_hold = sum(hold_times) / len(hold_times)
                return int(avg_hold)
        return 120  # Default 2 hours
    
    def archive_daily_logs(self):
        """Archive logs every 24 hours and reset"""
        today = datetime.now().strftime("%Y-%m-%d")
        archive_file = f"{self.daily_archive}{today}_trades.json"
        
        # Calculate daily performance
        daily_trades = [t for t in self.trades if t["timestamp"].startswith(today)]
        if daily_trades:
            total_profit = sum(t.get("profit_pct", 0) for t in daily_trades if t.get("profit_pct"))
            wins = sum(1 for t in daily_trades if t.get("success"))
            
            summary = {
                "date": today,
                "total_trades": len(daily_trades),
                "wins": wins,
                "losses": len(daily_trades) - wins,
                "win_rate": wins / len(daily_trades) if daily_trades else 0,
                "total_profit_pct": total_profit,
                "trades": daily_trades
            }
            
            with open(archive_file, 'w') as f:
                json.dump(summary, f, indent=2)
            
            print(f"📊 Daily Summary Archived: {archive_file}")
            print(f"   Trades: {len(daily_trades)} | Win Rate: {summary['win_rate']:.1%} | Profit: {total_profit:.1f}%")
        
        # Keep only last 7 days in memory
        cutoff = (datetime.now() - timedelta(days=7)).isoformat()
        self.trades = [t for t in self.trades if t["timestamp"] > cutoff]
        self._save_trades()
    
    def get_daily_performance(self):
        """Get today's performance metrics"""
        today = datetime.now().strftime("%Y-%m-%d")
        daily_trades = [t for t in self.trades if t["timestamp"].startswith(today)]
        
        if not daily_trades:
            return {"trades": 0, "profit": 0, "win_rate": 0}
        
        completed = [t for t in daily_trades if t.get("exit_price")]
        if not completed:
            return {"trades": len(daily_trades), "profit": 0, "win_rate": 0}
        
        total_profit = sum(t.get("profit_pct", 0) for t in completed)
        wins = sum(1 for t in completed if t.get("success"))
        
        return {
            "trades": len(completed),
            "profit": total_profit,
            "win_rate": wins / len(completed),
            "target_reached": total_profit >= 20
        }
    
    def _save_trades(self):
        with open(self.trades_db, 'w') as f:
            json.dump(self.trades, f, indent=2)
    
    def _save_insights(self):
        with open(self.learning_db, 'w') as f:
            json.dump(self.insights, f, indent=2)
    
    def get_recommendations(self):
        """Get AI recommendations based on learned patterns"""
        recs = []
        
        # Best symbols
        best_symbols = sorted(
            self.insights["symbol_win_rates"].items(),
            key=lambda x: x[1]["wins"] / (x[1]["wins"] + x[1]["losses"]) if (x[1]["wins"] + x[1]["losses"]) > 3 else 0,
            reverse=True
        )[:5]
        
        if best_symbols:
            recs.append(f"Best performing symbols: {', '.join([s[0] for s in best_symbols])}")
        
        # Best entry times
        all_hours = defaultdict(int)
        for symbol_hours in self.insights["best_entry_times"].values():
            for hour, count in symbol_hours.items():
                all_hours[hour] += count
        
        if all_hours:
            best_hour = max(all_hours.items(), key=lambda x: x[1])[0]
            recs.append(f"Best entry time: {best_hour}:00")
        
        return recs

# Global instance
learning_engine = TradingLearningEngine()

def get_learning_engine():
    """Get singleton learning engine."""
    return learning_engine
