"""
Diversification checker to avoid correlated positions.
Limits positions per sector and checks correlation.
"""
import yfinance as yf
import numpy as np
from typing import Dict, List
from src.utils import logger


class DiversificationChecker:
    """Check diversification rules before entering trades."""
    
    def __init__(self, max_per_sector: int = 2, max_correlation: float = 0.6):
        self.max_per_sector = max_per_sector
        self.max_correlation = max_correlation
        self.sector_cache = {}
    
    def get_sector(self, symbol: str) -> str:
        """Get sector for a symbol."""
        if symbol in self.sector_cache:
            return self.sector_cache[symbol]
        
        try:
            ticker = yf.Ticker(symbol)
            info = ticker.info
            sector = info.get('sector', 'Unknown')
            self.sector_cache[symbol] = sector
            return sector
        except:
            return 'Unknown'
    
    def check_sector_limit(self, symbol: str, current_positions: Dict) -> bool:
        """Check if adding this symbol would exceed sector limit."""
        new_sector = self.get_sector(symbol)
        
        if new_sector == 'Unknown':
            return True  # Allow if sector unknown
        
        # Count positions in same sector
        sector_count = sum(
            1 for pos_symbol in current_positions.keys()
            if self.get_sector(pos_symbol) == new_sector
        )
        
        if sector_count >= self.max_per_sector:
            logger.info(f"Sector limit: {symbol} ({new_sector}) - already have {sector_count} positions")
            return False
        
        return True
    
    def calculate_correlation(self, symbol1: str, symbol2: str, period: str = '30d') -> float:
        """Calculate correlation between two symbols."""
        try:
            data1 = yf.download(symbol1, period=period, progress=False)['Close']
            data2 = yf.download(symbol2, period=period, progress=False)['Close']
            
            if len(data1) < 10 or len(data2) < 10:
                return 0.0
            
            # Calculate returns
            returns1 = data1.pct_change().dropna()
            returns2 = data2.pct_change().dropna()
            
            # Align data
            common_dates = returns1.index.intersection(returns2.index)
            if len(common_dates) < 10:
                return 0.0
            
            returns1 = returns1.loc[common_dates]
            returns2 = returns2.loc[common_dates]
            
            # Calculate correlation
            correlation = np.corrcoef(returns1, returns2)[0, 1]
            return correlation
            
        except Exception as e:
            logger.debug(f"Correlation calc failed for {symbol1}/{symbol2}: {e}")
            return 0.0
    
    def check_correlation_limit(self, symbol: str, current_positions: Dict) -> bool:
        """Check if symbol is too correlated with existing positions."""
        if not current_positions:
            return True
        
        for pos_symbol in current_positions.keys():
            correlation = self.calculate_correlation(symbol, pos_symbol)
            
            if abs(correlation) > self.max_correlation:
                logger.info(
                    f"Correlation limit: {symbol} too correlated with {pos_symbol} "
                    f"({correlation:.2f} > {self.max_correlation})"
                )
                return False
        
        return True
    
    def can_add_position(self, symbol: str, current_positions: Dict) -> tuple[bool, str]:
        """
        Check if symbol can be added based on diversification rules.
        Returns (can_add, reason).
        """
        # Check sector limit
        if not self.check_sector_limit(symbol, current_positions):
            sector = self.get_sector(symbol)
            return False, f"Sector limit ({sector})"
        
        # Check correlation (skip if too many positions to avoid slowdown)
        if len(current_positions) <= 5:
            if not self.check_correlation_limit(symbol, current_positions):
                return False, "High correlation"
        
        return True, "OK"


# Global instance
_diversification_checker = None

def get_diversification_checker():
    """Get singleton diversification checker."""
    global _diversification_checker
    if _diversification_checker is None:
        _diversification_checker = DiversificationChecker(
            max_per_sector=2,
            max_correlation=0.6
        )
    return _diversification_checker
