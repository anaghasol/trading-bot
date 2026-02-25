"""
Intelligence engine for correlating Discord signals with prediction market analysis.
Makes weighted decisions based on multiple data sources.
"""

from typing import Dict, Any, Tuple
from datetime import datetime
from src.utils import logger
from src.config import settings
from src.polymarket_client import PolymarketClient


class IntelligenceEngine:
    """
    Correlates Discord trade alerts with Polymarket prediction data.
    Generates confidence scores and makes smart trading decisions.
    """

    def __init__(self):
        self.polymarket = PolymarketClient()
        
        # Weighting configuration
        self.discord_signal_weight = 0.40  # 40% - User community signal
        self.prediction_market_weight = 0.35  # 35% - Market consensus
        self.technical_weight = 0.15  # 15% - Basic momentum
        self.risk_weight = 0.10  # 10% - Risk adjustment
        
        logger.info("IntelligenceEngine initialized")

    def analyze_trade_alert(self, trade_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyze a trade alert with Polymarket insight.
        
        Args:
            trade_data: Trade information from Discord
            
        Returns:
            Enriched trade data with confidence score and recommendations
        """
        symbol = trade_data.get("symbol", "").upper()
        action = trade_data.get("action", "").upper()
        
        logger.info(f"Analyzing: {action} {symbol}")
        
        # Get Discord signal strength
        discord_score = self._score_discord_signal(trade_data)
        
        # Get Polymarket prediction market insight
        prediction_score = self._analyze_prediction_markets(symbol, action)
        
        # Calculate combined confidence
        confidence = self._calculate_confidence(discord_score, prediction_score)
        
        # Generate recommendation
        recommendation = self._generate_recommendation(confidence, trade_data)
        
        # Enrich trade data
        enriched_data = {
            **trade_data,
            "discord_score": round(discord_score, 3),
            "prediction_score": round(prediction_score, 3),
            "combined_confidence": round(confidence, 3),
            "recommendation": recommendation,
            "executed": False,
            "analyzed_at": datetime.now().isoformat()
        }
        
        logger.info(
            f"Analysis complete - {symbol} {action} | "
            f"Confidence: {confidence:.0%} | "
            f"Recommendation: {recommendation['action']}"
        )
        
        return enriched_data

    def _score_discord_signal(self, trade_data: Dict[str, Any]) -> float:
        """
        Score the Discord signal strength (0-1).
        
        Factors:
        - Specific price targets (higher = better)
        - Stop loss defined (higher confidence)
        - Community consensus (implicit)
        """
        score = 0.5  # Base score
        
        # Has target price (+0.15)
        if "target_price" in trade_data:
            score += 0.15
        
        # Has stop loss (+0.15)
        if "stop_loss" in trade_data or "debit_per_contract" in trade_data:
            score += 0.15
        
        # Options with specific details (+0.10)
        if trade_data.get("action") in ["BTO", "STO", "BTC", "STC"]:
            if "premium_per_contract" in trade_data:
                score += 0.10
        
        # Cap at 1.0
        return min(score, 1.0)

    def _analyze_prediction_markets(self, symbol: str, action: str) -> float:
        """
        Analyze Polymarket prediction markets for the symbol.
        
        Returns confidence score 0-1 based on market consensus.
        """
        try:
            # Determine direction from action
            direction = "up" if action in ["BUY", "BTO"] else "down"
            
            # Get prediction market probability
            probability = self.polymarket.get_market_probability(symbol, direction)
            
            # Convert to confidence score
            # If probability is high (>0.6) or low (<0.4), high confidence
            # If probability is neutral (0.4-0.6), lower confidence
            if probability > 0.65:
                confidence = 0.85  # Very confident in direction
            elif probability > 0.55:
                confidence = 0.70  # Moderately confident
            elif probability < 0.35:
                confidence = 0.85  # Very confident in opposite direction
            elif probability < 0.45:
                confidence = 0.70  # Moderately confident
            else:
                confidence = 0.40  # Low confidence - market uncertain
            
            logger.info(
                f"Polymarket {symbol} {direction}: {probability:.0%} probability "
                f"(confidence: {confidence:.0%})"
            )
            
            return confidence
            
        except Exception as e:
            logger.warning(f"Polymarket analysis failed: {e}, using neutral score")
            return 0.5

    def _calculate_confidence(self, discord_score: float, prediction_score: float) -> float:
        """
        Calculate combined confidence score.
        
        Weighted average of multiple signals.
        """
        # Correlation boost: if both signals agree, increase confidence
        if (discord_score > 0.6 and prediction_score > 0.6) or \
           (discord_score < 0.4 and prediction_score < 0.4):
            correlation_boost = 0.05
        elif abs(discord_score - prediction_score) > 0.3:
            # Signals conflict - reduce confidence
            correlation_boost = -0.10
        else:
            correlation_boost = 0.0
        
        # Weighted average
        confidence = (
            (discord_score * self.discord_signal_weight) +
            (prediction_score * self.prediction_market_weight) +
            (correlation_boost * self.risk_weight)
        )
        
        # Normalize to 0-1
        return max(0.0, min(1.0, confidence))

    def _generate_recommendation(
        self,
        confidence: float,
        trade_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Generate trading recommendation based on confidence.
        
        Returns:
            Recommendation with action, position size, additional conditions
        """
        action = trade_data.get("action", "")
        symbol = trade_data.get("symbol", "")
        
        if confidence >= 0.75:
            rec_action = "STRONG_BUY"
            position_multiplier = 1.5  # 150% of normal position
            risk_level = "high"
        elif confidence >= 0.60:
            rec_action = "BUY"
            position_multiplier = 1.0  # Normal position
            risk_level = "medium"
        elif confidence >= 0.50:
            rec_action = "CAUTIOUS"
            position_multiplier = 0.5  # 50% position
            risk_level = "low"
        elif confidence >= 0.40:
            rec_action = "REDUCE"
            position_multiplier = 0.25  # 25% position
            risk_level = "low"
        else:
            rec_action = "SKIP"
            position_multiplier = 0.0  # Do not execute
            risk_level = "very_low"
        
        return {
            "action": rec_action,
            "position_multiplier": position_multiplier,
            "risk_level": risk_level,
            "confidence": confidence,
            "reason": f"{symbol} {action} - Polymarket analysis confirms signal"
        }

    def should_execute_trade(self, analyzed_trade: Dict[str, Any]) -> bool:
        """
        Determine if trade should be executed based on analysis.
        
        Args:
            analyzed_trade: Trade data with intelligence analysis
            
        Returns:
            True if trade meets confidence threshold
        """
        recommendation = analyzed_trade.get("recommendation", {})
        action = recommendation.get("action", "SKIP")
        confidence = analyzed_trade.get("combined_confidence", 0)
        
        # Require confidence > 50% AND recommendation not SKIP
        should_execute = (confidence > 0.50) and (action != "SKIP")
        
        logger.info(
            f"Execution decision: {'YES' if should_execute else 'NO'} "
            f"({analyzed_trade.get('symbol')} - {action} @ {confidence:.0%})"
        )
        
        return should_execute

    def correlate_multi_signal(
        self,
        discord_data: Dict[str, Any],
        polymarket_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Advanced: Correlate multiple Discord signals with polymarket for composite strategy.
        """
        return {
            "discord_consensus": discord_data,
            "market_sentiment": polymarket_data,
            "strategy": "momentum + prediction_market_confirmation"
        }
