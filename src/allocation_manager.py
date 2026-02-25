"""
Asset allocation manager for stocks/options split.
Manages capital allocation between stocks and options based on configuration.
"""
import os
from typing import Dict, Literal

AllocationMode = Literal["fixed", "dynamic"]


class AllocationManager:
    """Manage capital allocation between stocks and options."""
    
    def __init__(self, total_capital: float):
        self.total_capital = total_capital
        self.mode: AllocationMode = os.getenv("ALLOC_SPLIT_MODE", "dynamic")
        self.stock_pct = float(os.getenv("STOCK_ALLOC_PCT", "70")) / 100
        self.options_pct = float(os.getenv("OPTIONS_ALLOC_PCT", "30")) / 100
        self.options_enabled = os.getenv("OPTIONS_ENABLED", "false").lower() == "true"
        self.random_select = os.getenv("RANDOM_SELECT", "true").lower() == "true"
        
        # Track allocated capital
        self.stock_allocated = 0.0
        self.options_allocated = 0.0
    
    def get_allocation(self, regime: str = "FLAT") -> Dict[str, float]:
        """Get current allocation based on mode and regime."""
        if not self.options_enabled:
            # Options disabled - 100% stocks
            return {
                "stock_capital": self.total_capital,
                "options_capital": 0.0,
                "stock_pct": 1.0,
                "options_pct": 0.0
            }
        
        if self.mode == "fixed":
            # Fixed allocation
            return {
                "stock_capital": self.total_capital * self.stock_pct,
                "options_capital": self.total_capital * self.options_pct,
                "stock_pct": self.stock_pct,
                "options_pct": self.options_pct
            }
        
        else:  # dynamic
            # Adjust based on regime
            if regime == "BULL":
                # Bull market - favor stocks
                stock_pct = 0.80
                options_pct = 0.20
            elif regime == "BEAR":
                # Bear market - favor options (put spreads)
                stock_pct = 0.50
                options_pct = 0.50
            else:  # FLAT
                # Balanced
                stock_pct = 0.70
                options_pct = 0.30
            
            return {
                "stock_capital": self.total_capital * stock_pct,
                "options_capital": self.total_capital * options_pct,
                "stock_pct": stock_pct,
                "options_pct": options_pct
            }
    
    def can_allocate_stock(self, amount: float, regime: str = "FLAT") -> bool:
        """Check if stock allocation available."""
        alloc = self.get_allocation(regime)
        return (self.stock_allocated + amount) <= alloc["stock_capital"]
    
    def can_allocate_options(self, amount: float, regime: str = "FLAT") -> bool:
        """Check if options allocation available."""
        if not self.options_enabled:
            return False
        
        alloc = self.get_allocation(regime)
        return (self.options_allocated + amount) <= alloc["options_capital"]
    
    def allocate_stock(self, amount: float):
        """Allocate capital to stock trade."""
        self.stock_allocated += amount
    
    def allocate_options(self, amount: float):
        """Allocate capital to options trade."""
        self.options_allocated += amount
    
    def release_stock(self, amount: float):
        """Release stock capital after trade closes."""
        self.stock_allocated = max(0, self.stock_allocated - amount)
    
    def release_options(self, amount: float):
        """Release options capital after trade closes."""
        self.options_allocated = max(0, self.options_allocated - amount)
    
    def reset_daily(self):
        """Reset allocations at start of day."""
        self.stock_allocated = 0.0
        self.options_allocated = 0.0
    
    def get_status(self, regime: str = "FLAT") -> Dict:
        """Get current allocation status."""
        alloc = self.get_allocation(regime)
        
        return {
            "mode": self.mode,
            "regime": regime,
            "total_capital": self.total_capital,
            "stock_allocated": self.stock_allocated,
            "stock_available": alloc["stock_capital"] - self.stock_allocated,
            "stock_pct": alloc["stock_pct"],
            "options_allocated": self.options_allocated,
            "options_available": alloc["options_capital"] - self.options_allocated,
            "options_pct": alloc["options_pct"],
            "options_enabled": self.options_enabled
        }


# Global instance
_allocation_manager = None

def get_allocation_manager(capital: float = None):
    """Get singleton allocation manager."""
    global _allocation_manager
    if _allocation_manager is None and capital:
        _allocation_manager = AllocationManager(capital)
    return _allocation_manager
