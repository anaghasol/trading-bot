"""
Market regime detection to adapt strategy weights dynamically.
Classifies market as BULL, BEAR, or FLAT based on volatility and trend.
"""
import numpy as np
from typing import Dict, Literal

RegimeType = Literal["BULL", "BEAR", "FLAT"]


class RegimeDetector:
    """Detect market regime and adjust strategy weights."""
    
    def __init__(self):
        self.current_regime: RegimeType = "FLAT"
        self.regime_confidence = 0.0
    
    def detect_regime(
        self, 
        close_prices: list, 
        atr: float, 
        volume: float, 
        avg_volume: float
    ) -> Dict:
        """
        Detect market regime based on price action and volatility.
        
        Returns:
            - regime: BULL, BEAR, or FLAT
            - openclaw_weight: Adjusted weight for technical analysis
            - polymarket_weight: Adjusted weight for sentiment
        """
        if len(close_prices) < 20:
            return self._default_weights()
        
        # Calculate trend strength
        sma_5 = np.mean(close_prices[-5:])
        sma_20 = np.mean(close_prices[-20:])
        current_price = close_prices[-1]
        
        trend_strength = (sma_5 - sma_20) / sma_20 if sma_20 > 0 else 0
        
        # Calculate volatility (normalized ATR)
        volatility = atr / current_price if current_price > 0 else 0
        
        # Volume confirmation
        volume_ratio = volume / avg_volume if avg_volume > 0 else 1.0
        
        # Classify regime
        if volatility > 0.03 and abs(trend_strength) > 0.02:
            # High volatility + strong trend = BULL or BEAR
            if trend_strength > 0:
                regime = "BULL"
                # In bull markets, trust technical analysis more
                openclaw_weight = 0.70
                polymarket_weight = 0.30
            else:
                regime = "BEAR"
                # In bear markets, trust sentiment more (avoid falling knives)
                openclaw_weight = 0.50
                polymarket_weight = 0.50
            confidence = min(abs(trend_strength) * 20, 1.0)
        
        elif volatility < 0.015:
            # Low volatility = FLAT (mean-reversion mode)
            regime = "FLAT"
            # In flat markets, balance both signals
            openclaw_weight = 0.55
            polymarket_weight = 0.45
            confidence = 0.6
        
        else:
            # Uncertain regime - use default
            return self._default_weights()
        
        self.current_regime = regime
        self.regime_confidence = confidence
        
        return {
            "regime": regime,
            "confidence": confidence,
            "openclaw_weight": openclaw_weight,
            "polymarket_weight": polymarket_weight,
            "volume_confirmed": volume_ratio > 1.5
        }
    
    def _default_weights(self) -> Dict:
        """Return default 60/40 weights when regime unclear."""
        return {
            "regime": "FLAT",
            "confidence": 0.5,
            "openclaw_weight": 0.60,
            "polymarket_weight": 0.40,
            "volume_confirmed": False
        }
    
    def get_entry_threshold(self) -> float:
        """Adjust entry threshold based on regime."""
        if self.current_regime == "BULL" and self.regime_confidence > 0.7:
            return 0.58  # Lower threshold in strong bull
        elif self.current_regime == "BEAR":
            return 0.65  # Higher threshold in bear (be cautious)
        else:
            return 0.60  # Default
