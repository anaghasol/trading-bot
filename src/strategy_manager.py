"""
Strategy Manager for 20-30% Daily Return Target
Prioritizes Discord signals, uses OpenClaw as backup
Auto-exits when target reached
"""

from datetime import datetime, time
from typing import Dict, Optional
from src.utils import logger


class DailyReturnStrategy:
    """
    Manages daily return targets and exit strategy.
    
    Goal: 20-30% daily returns
    Priority: Discord first (blind execution), OpenClaw backup
    Exit: Auto-exit at target OR Discord exit signal
    """
    
    def __init__(self, target_return_min: float = 0.20, target_return_max: float = 0.30):
        self.target_return_min = target_return_min  # 20%
        self.target_return_max = target_return_max  # 30%
        self.daily_start_balance = 0.0
        self.current_balance = 0.0
        self.daily_return = 0.0
        self.target_reached = False
        self.trades_today = []
        self.last_reset = datetime.now().date()
        
        logger.info(f"📈 Daily Return Strategy: Target {target_return_min:.0%}-{target_return_max:.0%}")
    
    def reset_daily_tracking(self, starting_balance: float):
        """Reset tracking at start of trading day."""
        self.daily_start_balance = starting_balance
        self.current_balance = starting_balance
        self.daily_return = 0.0
        self.target_reached = False
        self.trades_today = []
        self.last_reset = datetime.now().date()
        logger.info(f"🔄 Daily tracking reset. Starting balance: ${starting_balance:,.2f}")
    
    def update_balance(self, new_balance: float):
        """Update current balance and calculate return."""
        self.current_balance = new_balance
        
        if self.daily_start_balance > 0:
            self.daily_return = (new_balance - self.daily_start_balance) / self.daily_start_balance
            
            # Check if target reached
            if self.daily_return >= self.target_return_min and not self.target_reached:
                self.target_reached = True
                logger.info(f"🎯 TARGET REACHED! Daily return: {self.daily_return:.2%}")
                logger.info(f"💰 Profit: ${new_balance - self.daily_start_balance:,.2f}")
    
    def should_take_trade(self, source: str) -> bool:
        """
        Determine if we should take a new trade.
        
        Priority logic:
        1. Always take Discord signals (priority)
        2. Take OpenClaw only if no Discord signals or need backup
        3. Stop all trading if target reached
        """
        # Check if we need daily reset
        if datetime.now().date() > self.last_reset:
            logger.info("📅 New trading day detected - will reset on next balance update")
        
        # If target reached, exit all and stop trading
        if self.target_reached:
            logger.info(f"🛑 Target reached ({self.daily_return:.2%}), no new trades")
            return False
        
        # Always take Discord signals (priority)
        if source == "DISCORD":
            logger.info("✅ Discord signal - EXECUTING (priority)")
            return True
        
        # Take OpenClaw as backup
        if source == "OPENCLAW":
            logger.info("✅ OpenClaw signal - EXECUTING (backup)")
            return True
        
        return False
    
    def should_exit_position(self, entry_price: float, current_price: float, 
                            position_return: float) -> tuple[bool, str]:
        """
        Determine if we should exit a position.
        
        Exit conditions:
        1. Daily target reached (exit all)
        2. Position hit individual target (20-30%)
        3. Discord exit signal received
        """
        # Exit all if daily target reached
        if self.target_reached:
            return True, f"Daily target reached ({self.daily_return:.2%})"
        
        # Exit individual position if it hit 20-30% gain
        if position_return >= self.target_return_min:
            return True, f"Position target reached ({position_return:.2%})"
        
        return False, ""
    
    def log_trade(self, trade_data: Dict):
        """Log trade for daily tracking."""
        self.trades_today.append({
            "timestamp": datetime.now(),
            "symbol": trade_data.get("symbol"),
            "action": trade_data.get("action"),
            "source": trade_data.get("source"),
            "price": trade_data.get("price")
        })
    
    def get_daily_summary(self) -> Dict:
        """Get summary of today's performance."""
        return {
            "start_balance": self.daily_start_balance,
            "current_balance": self.current_balance,
            "daily_return": self.daily_return,
            "profit_loss": self.current_balance - self.daily_start_balance,
            "target_reached": self.target_reached,
            "trades_count": len(self.trades_today),
            "discord_trades": len([t for t in self.trades_today if t.get("source") == "DISCORD"]),
            "openclaw_trades": len([t for t in self.trades_today if t.get("source") == "OPENCLAW"])
        }
    
    def print_status(self):
        """Print current status."""
        summary = self.get_daily_summary()
        
        logger.info("=" * 80)
        logger.info("📊 DAILY PERFORMANCE STATUS")
        logger.info("=" * 80)
        logger.info(f"Starting Balance: ${summary['start_balance']:,.2f}")
        logger.info(f"Current Balance:  ${summary['current_balance']:,.2f}")
        logger.info(f"Daily Return:     {summary['daily_return']:.2%}")
        logger.info(f"Profit/Loss:      ${summary['profit_loss']:,.2f}")
        logger.info(f"Target Status:    {'✅ REACHED' if summary['target_reached'] else '⏳ In Progress'}")
        logger.info(f"Trades Today:     {summary['trades_count']} (Discord: {summary['discord_trades']}, OpenClaw: {summary['openclaw_trades']})")
        logger.info("=" * 80)
