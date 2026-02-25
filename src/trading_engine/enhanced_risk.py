"""
Enhanced risk management with ATR-based stops and adaptive position sizing.
"""
import numpy as np
from typing import Dict, Any


class EnhancedRiskManager:
    """Advanced risk management with volatility-based adjustments."""
    
    def __init__(self, max_daily_loss_pct: float = 2.0):
        self.max_daily_loss_pct = max_daily_loss_pct
        self.daily_pnl = 0.0
        self.starting_balance = 0.0
        self.circuit_breaker_triggered = False
    
    def calculate_atr(self, high: list, low: list, close: list, period: int = 14) -> float:
        """Calculate Average True Range for volatility-based stops."""
        if len(high) < period + 1:
            return 0.0
        
        tr_list = []
        for i in range(1, len(high)):
            tr = max(
                high[i] - low[i],
                abs(high[i] - close[i-1]),
                abs(low[i] - close[i-1])
            )
            tr_list.append(tr)
        
        return np.mean(tr_list[-period:]) if tr_list else 0.0
    
    def get_dynamic_stop_loss(self, entry_price: float, atr: float, action: str) -> float:
        """Calculate stop-loss based on 2x ATR instead of fixed percentage."""
        if atr == 0:
            # Fallback to 1% if ATR unavailable
            return entry_price * 0.99 if action == "BUY" else entry_price * 1.01
        
        stop_distance = 2 * atr
        if action == "BUY":
            return entry_price - stop_distance
        else:
            return entry_price + stop_distance
    
    def get_dynamic_take_profit(self, entry_price: float, stop_loss: float, action: str) -> float:
        """Calculate take-profit at 2:1 reward:risk ratio."""
        risk = abs(entry_price - stop_loss)
        reward = risk * 2  # 2:1 ratio
        
        if action == "BUY":
            return entry_price + reward
        else:
            return entry_price - reward
    
    def calculate_position_size_1pct_rule(
        self, 
        account_balance: float, 
        entry_price: float, 
        stop_loss: float,
        confidence: float
    ) -> int:
        """
        Calculate position size using 1% rule: never risk more than 1% of capital.
        Scale up to 1.5% if confidence > 75%.
        """
        # Determine risk percentage based on confidence
        if confidence > 0.75:
            risk_pct = 0.015  # 1.5% for high confidence
        else:
            risk_pct = 0.01   # 1% standard
        
        risk_amount = account_balance * risk_pct
        risk_per_share = abs(entry_price - stop_loss)
        
        if risk_per_share == 0:
            return 0
        
        position_size = int(risk_amount / risk_per_share)
        
        # Cap at 5% of account value
        max_position_value = account_balance * 0.05
        max_shares = int(max_position_value / entry_price)
        
        return min(position_size, max_shares)
    
    def check_circuit_breaker(self, current_balance: float) -> bool:
        """
        Check if daily loss limit hit (2% max loss per day).
        Returns True if trading should stop.
        """
        if self.starting_balance == 0:
            self.starting_balance = current_balance
            return False
        
        self.daily_pnl = current_balance - self.starting_balance
        loss_pct = (self.daily_pnl / self.starting_balance) * 100
        
        if loss_pct <= -self.max_daily_loss_pct:
            self.circuit_breaker_triggered = True
            return True
        
        return False
    
    def check_volume_filter(self, current_volume: float, avg_volume: float) -> bool:
        """Only trade if volume > 1.5x average to confirm trends."""
        return current_volume > (avg_volume * 1.5)
    
    def reset_daily(self, starting_balance: float):
        """Reset daily tracking at market open."""
        self.starting_balance = starting_balance
        self.daily_pnl = 0.0
        self.circuit_breaker_triggered = False
