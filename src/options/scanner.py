"""
Options scanner for bear put spreads.
"""
from typing import Dict, Optional


class OptionsScanner:
    """Scan bear put spread opportunities."""
    
    def __init__(self, ibkr_client):
        self.ibkr = ibkr_client
    
    def find_bear_put_spread(self, symbol: str, stock_price: float, atr: float, iv: float = 35) -> Optional[Dict]:
        """Find optimal bear put spread."""
        if iv < 30:
            return None
        
        upper_strike = round(stock_price)
        lower_strike = round(stock_price * 0.93)
        spread_width = upper_strike - lower_strike
        estimated_debit = spread_width * 0.4
        
        if estimated_debit > stock_price * 0.05:
            return None
        
        return {
            'symbol': symbol,
            'upper_strike': upper_strike,
            'lower_strike': lower_strike,
            'estimated_debit': estimated_debit,
            'max_loss': estimated_debit * 100,
            'max_gain': (spread_width - estimated_debit) * 100,
            'breakeven': upper_strike - estimated_debit
        }
