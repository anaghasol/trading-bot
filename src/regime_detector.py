"""
Market regime detection to adapt strategy weights dynamically.
Classifies market as BULL, BEAR, or FLAT based on volatility and trend.
"""
import numpy as np
from typing import Dict, Literal

RegimeType = Literal["BULL", "BEAR", "FLAT"]


class RegimeDetector:
    """Detect market regime and adjust strategy weights."""
    
    def __init__(self, bull_atr_threshold: float = 0.03, bear_atr_threshold: float = 0.03, 
                 flat_atr_threshold: float = 0.015, trend_threshold: float = 0.02):
        self.current_regime: RegimeType = "FLAT"
        self.regime_confidence = 0.0
        
        # Configurable thresholds (can override via env)
        import os
        self.bull_atr_threshold = float(os.getenv("REGIME_BULL_ATR", str(bull_atr_threshold)))
        self.bear_atr_threshold = float(os.getenv("REGIME_BEAR_ATR", str(bear_atr_threshold)))
        self.flat_atr_threshold = float(os.getenv("REGIME_FLAT_ATR", str(flat_atr_threshold)))
        self.trend_threshold = float(os.getenv("REGIME_TREND_THRESHOLD", str(trend_threshold)))
        
        # Weight overrides
        self.bull_openclaw = float(os.getenv("REGIME_BULL_OPENCLAW_WEIGHT", "0.70"))
        self.bull_poly = float(os.getenv("REGIME_BULL_POLY_WEIGHT", "0.30"))
        self.bear_openclaw = float(os.getenv("REGIME_BEAR_OPENCLAW_WEIGHT", "0.50"))
        self.bear_poly = float(os.getenv("REGIME_BEAR_POLY_WEIGHT", "0.50"))
        self.flat_openclaw = float(os.getenv("REGIME_FLAT_OPENCLAW_WEIGHT", "0.55"))
        self.flat_poly = float(os.getenv("REGIME_FLAT_POLY_WEIGHT", "0.45"))
    
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
        if volatility > self.bull_atr_threshold and abs(trend_strength) > self.trend_threshold:
            # High volatility + strong trend = BULL or BEAR
            if trend_strength > 0:
                regime = "BULL"
                openclaw_weight = self.bull_openclaw
                polymarket_weight = self.bull_poly
            else:
                regime = "BEAR"
                openclaw_weight = self.bear_openclaw
                polymarket_weight = self.bear_poly
            confidence = min(abs(trend_strength) * 20, 1.0)
        
        elif volatility < self.flat_atr_threshold:
            # Low volatility = FLAT (mean-reversion mode)
            regime = "FLAT"
            openclaw_weight = self.flat_openclaw
            polymarket_weight = self.flat_poly
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
