"""
Risk management module.
Handles position sizing, stop losses, and trailing stops.
"""

import random
from typing import Optional, Dict, Any
from src.utils import logger
from src.config import settings


class RiskManager:
    """Manages risk parameters for trades."""

    def __init__(self):
        self.stop_loss_percent = settings.stop_loss_percent
        self.trailing_stop_percent = settings.trailing_stop_percent
        self.max_position_size_percent = settings.max_position_size_percent
        self.active_positions = {}
        logger.info(
            f"RiskManager initialized - SL: {self.stop_loss_percent}%, "
            f"TS: {self.trailing_stop_percent}%, Position Size: {self.max_position_size_percent}%"
        )

    def calculate_position_size(self, account_balance: float, risk_amount: float) -> int:
        """
        Calculate position size based on account balance and max position size percent.
        
        Args:
            account_balance: Account balance
            risk_amount: Amount willing to risk per trade
            
        Returns:
            Number of shares/contracts to trade
        """
        max_position_value = account_balance * (self.max_position_size_percent / 100)
        position_size = int(max_position_value / risk_amount)
        
        logger.info(
            f"Position size calculated: {position_size} "
            f"(Account: ${account_balance}, Max position: {self.max_position_size_percent}%)"
        )
        return position_size

    def get_stop_loss_price(self, entry_price: float, order_type: str = "BUY") -> float:
        """
        Calculate stop loss price based on stop loss percent.
        
        Args:
            entry_price: Entry price
            order_type: BUY or SELL
            
        Returns:
            Stop loss price
        """
        if order_type.upper() == "BUY":
            stop_loss = entry_price * (1 - self.stop_loss_percent / 100)
        else:  # SELL
            stop_loss = entry_price * (1 + self.stop_loss_percent / 100)
        
        return round(stop_loss, 2)

    def get_trailing_stop_price(
        self,
        current_price: float,
        order_type: str = "BUY"
    ) -> float:
        """
        Calculate trailing stop price when position is up by trailing stop percent.
        
        Args:
            current_price: Current price
            order_type: BUY or SELL
            
        Returns:
            Trailing stop price
        """
        if order_type.upper() == "BUY":
            trailing_stop = current_price * (1 - self.trailing_stop_percent / 100)
        else:  # SELL
            trailing_stop = current_price * (1 + self.trailing_stop_percent / 100)
        
        return round(trailing_stop, 2)

    def should_use_trailing_stop(
        self,
        current_price: float,
        entry_price: float,
        order_type: str = "BUY"
    ) -> bool:
        """
        Check if position should move to trailing stop.
        
        Args:
            current_price: Current price
            entry_price: Entry price
            order_type: BUY or SELL
            
        Returns:
            True if position is up by trailing stop threshold
        """
        if order_type.upper() == "BUY":
            profit_percent = ((current_price - entry_price) / entry_price) * 100
            return profit_percent >= self.trailing_stop_percent
        else:  # SELL
            profit_percent = ((entry_price - current_price) / entry_price) * 100
            return profit_percent >= self.trailing_stop_percent

    def get_random_concurrent_trades(self) -> int:
        """
        Get random number of concurrent trades between min and max.
        
        Returns:
            Random number between min and max concurrent trades
        """
        concurrent_trades = random.randint(
            settings.min_concurrent_trades,
            settings.max_concurrent_trades
        )
        logger.info(f"Random concurrent trades set to: {concurrent_trades}")
        return concurrent_trades

    def register_position(self, trade_id: str, trade_data: Dict[str, Any]):
        """Register a new position."""
        self.active_positions[trade_id] = {
            **trade_data,
            "status": "OPEN",
            "highest_price": trade_data.get("price"),
            "trailing_stop_active": False
        }
        logger.info(f"Position registered: {trade_id}")

    def update_position(self, trade_id: str, current_price: float):
        """Update position with current price and check for trailing stop."""
        if trade_id not in self.active_positions:
            return

        position = self.active_positions[trade_id]
        order_type = position.get("action")
        entry_price = position.get("price")

        # Update highest price for buy orders
        if order_type == "BUY" and current_price > position["highest_price"]:
            position["highest_price"] = current_price

        # Check if trailing stop should be activated
        if not position["trailing_stop_active"]:
            if self.should_use_trailing_stop(current_price, entry_price, order_type):
                position["trailing_stop_active"] = True
                position["trailing_stop_price"] = self.get_trailing_stop_price(
                    current_price, order_type
                )
                logger.info(f"Trailing stop activated for {trade_id}")

    def get_active_positions_count(self) -> int:
        """Get count of active positions."""
        return len([p for p in self.active_positions.values() if p["status"] == "OPEN"])

    def close_position(self, trade_id: str):
        """Close a position."""
        if trade_id in self.active_positions:
            self.active_positions[trade_id]["status"] = "CLOSED"
            logger.info(f"Position closed: {trade_id}")
