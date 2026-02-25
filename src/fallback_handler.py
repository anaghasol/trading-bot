"""
Fallback and adaptivity handler for trading signals.
Handles dependency failures and adapts strategy weights.
"""
from typing import Dict, Any
from src.utils import logger


class FallbackHandler:
    """Handles fallbacks when dependencies fail."""
    
    def __init__(self):
        self.polymarket_failures = 0
        self.openclaw_failures = 0
        self.performance_log = []
    
    def get_signal_with_fallback(
        self, 
        symbol: str,
        openclaw_agent,
        polymarket_client
    ) -> Dict[str, Any]:
        """
        Get trading signal with fallback logic.
        If Polymarket fails, use OpenClaw only with higher threshold.
        """
        try:
            # Try OpenClaw first
            openclaw_signal = openclaw_agent.analyze_market(symbol)
            openclaw_score = openclaw_signal.get('trend_score', 0.5)
            openclaw_success = True
        except Exception as e:
            logger.error(f"OpenClaw failed for {symbol}: {e}")
            self.openclaw_failures += 1
            openclaw_score = 0.5
            openclaw_success = False
        
        try:
            # Try Polymarket
            poly_analysis = polymarket_client.analyze_stock_sentiment(symbol)
            poly_score = poly_analysis.get('probability', 0.5)
            poly_success = True
        except Exception as e:
            logger.warning(f"Polymarket failed for {symbol}: {e}")
            self.polymarket_failures += 1
            poly_score = 0.5
            poly_success = False
        
        # Determine strategy based on what's available
        if openclaw_success and poly_success:
            # Both available - use dual validation
            combined = (openclaw_score * 0.6) + (poly_score * 0.4)
            should_trade = openclaw_score > 0.55 and poly_score > 0.55 and combined > 0.60
            mode = "DUAL"
        
        elif openclaw_success and not poly_success:
            # Polymarket down - use OpenClaw only with higher threshold
            combined = openclaw_score
            should_trade = openclaw_score > 0.70  # Higher threshold for safety
            mode = "OPENCLAW_ONLY"
            logger.info(f"{symbol}: Using OpenClaw fallback (Polymarket unavailable)")
        
        elif poly_success and not openclaw_success:
            # OpenClaw down - use Polymarket only with higher threshold
            combined = poly_score
            should_trade = poly_score > 0.70
            mode = "POLYMARKET_ONLY"
            logger.info(f"{symbol}: Using Polymarket fallback (OpenClaw unavailable)")
        
        else:
            # Both failed - skip trade
            combined = 0.5
            should_trade = False
            mode = "SKIP"
            logger.error(f"{symbol}: Both signals failed - skipping")
        
        return {
            'should_trade': should_trade,
            'combined_confidence': combined,
            'openclaw_score': openclaw_score,
            'poly_score': poly_score,
            'mode': mode
        }
    
    def log_performance(self, trade_result: Dict[str, Any]):
        """Log trade performance for future weight adjustment."""
        self.performance_log.append(trade_result)
        
        # Keep last 100 trades
        if len(self.performance_log) > 100:
            self.performance_log.pop(0)
    
    def get_failure_stats(self) -> Dict[str, int]:
        """Get failure statistics."""
        return {
            'openclaw_failures': self.openclaw_failures,
            'polymarket_failures': self.polymarket_failures
        }
    
    def suggest_weight_adjustment(self) -> Dict[str, float]:
        """ML-lite: Adjust weights based on last 7 days accuracy."""
        from src.audit_logger import get_audit_logger
        
        audit = get_audit_logger()
        metrics = audit.get_performance_metrics(days=7)
        
        openclaw_acc = metrics.get('openclaw_accuracy', 0.5)
        poly_acc = metrics.get('polymarket_accuracy', 0.5)
        
        # Adjust weights: give +5% to better performer
        if openclaw_acc > poly_acc + 0.1:
            return {'openclaw': 0.65, 'polymarket': 0.35}
        elif poly_acc > openclaw_acc + 0.1:
            return {'openclaw': 0.55, 'polymarket': 0.45}
        else:
            return {'openclaw': 0.6, 'polymarket': 0.4}


# Global instance
_fallback_handler = None

def get_fallback_handler():
    """Get singleton fallback handler."""
    global _fallback_handler
    if _fallback_handler is None:
        _fallback_handler = FallbackHandler()
    return _fallback_handler
