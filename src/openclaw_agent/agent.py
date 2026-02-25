"""
OpenClaw AI Agent for autonomous market analysis and trading.
Analyzes market conditions without needing Discord signals.
"""

import asyncio
from typing import Dict, List, Any, Optional
from datetime import datetime
from src.utils import logger
from src.config import settings
from src.polymarket_client import PolymarketClient


class OpenClawAgent:
    """
    Autonomous AI agent using OpenClaw framework.
    - Analyzes market conditions
    - Identifies trading opportunities
    - Validates with Polymarket
    - Generates independent trading signals
    """

    def __init__(self):
        self.polymarket = PolymarketClient()
        self.analysis_interval = 30  # Analyze every 30 seconds (faster for more opportunities)
        self.active_analyses = {}
        self.execution_metrics = {}  # Track execution speed like crypto traders
        logger.info("OpenClawAgent initialized - 30sec scan interval for continuous opportunity capture")

    async def analyze_market(self, symbol: str) -> Dict[str, Any]:
        """
        Autonomous market analysis without Discord signals.
        
        Uses:
        - Technical analysis (momentum, trends)
        - Polymarket prediction markets
        - Market sentiment
        - Risk/reward ratio
        
        Args:
            symbol: Stock/crypto symbol (e.g., "AAPL", "BTC")
            
        Returns:
            Trade signal with confidence and action
        """
        try:
            logger.info(f"OpenClaw analyzing: {symbol}")
            
            # Step 1: Get market trend from technical indicators
            trend_score = await self._analyze_technical_trend(symbol)
            logger.debug(f"{symbol} trend score: {trend_score:.0%}")
            
            # Step 2: Get Polymarket prediction consensus
            prediction_score = await self._analyze_prediction_market(symbol)
            logger.debug(f"{symbol} prediction score: {prediction_score:.0%}")
            
            # Step 3: Calculate risk/reward ratio
            risk_reward = await self._calculate_risk_reward(symbol)
            logger.debug(f"{symbol} risk/reward: {risk_reward:.2f}")
            
            # Step 4: Generate trading signal
            signal = self._generate_openclaw_signal(
                symbol, trend_score, prediction_score, risk_reward
            )
            
            logger.info(
                f"OpenClaw Signal: {symbol} - Action: {signal.get('action')}, "
                f"Confidence: {signal.get('confidence'):.0%}, "
                f"Reason: {signal.get('reason')}"
            )
            
            return signal
            
        except Exception as e:
            logger.error(f"OpenClaw analysis failed for {symbol}: {e}")
            return {
                "action": "SKIP",
                "confidence": 0.0,
                "reason": f"Analysis error: {e}"
            }

    async def _analyze_technical_trend(self, symbol: str) -> float:
        """
        Analyze technical trend using REAL price data.
        
        Returns:
            Score 0-1 (0=strong downtrend, 0.5=neutral, 1=strong uptrend)
        """
        try:
            import yfinance as yf
            
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period='5d', interval='1h')
            
            if len(hist) < 10:
                return 0.5  # Not enough data
            
            # Calculate momentum indicators
            current = float(hist['Close'].iloc[-1])
            hour_ago = float(hist['Close'].iloc[-2])
            day_ago = float(hist['Close'].iloc[-24]) if len(hist) >= 24 else float(hist['Close'].iloc[0])
            
            # Short-term momentum (1 hour)
            short_momentum = (current - hour_ago) / hour_ago
            
            # Medium-term momentum (1 day)
            medium_momentum = (current - day_ago) / day_ago
            
            # Volume trend (increasing = bullish)
            recent_volume = hist['Volume'].iloc[-5:].mean()
            older_volume = hist['Volume'].iloc[-10:-5].mean()
            volume_trend = (recent_volume - older_volume) / older_volume if older_volume > 0 else 0
            
            # Combine signals
            # Strong uptrend: positive momentum + volume
            # Strong downtrend: negative momentum + volume
            trend_score = 0.5  # Start neutral
            
            # Add momentum (40% weight)
            momentum_score = (short_momentum * 0.6 + medium_momentum * 0.4) * 10
            trend_score += momentum_score * 0.4
            
            # Add volume (20% weight)
            volume_score = volume_trend * 5
            trend_score += volume_score * 0.2
            
            # Clamp to 0-1
            trend_score = max(0.0, min(1.0, trend_score))
            
            return trend_score
            
        except Exception as e:
            logger.warning(f"Technical analysis failed: {e}")
            return 0.5  # Neutral

    async def _analyze_prediction_market(self, symbol: str) -> float:
        """
        Analyze Polymarket prediction markets.
        
        Returns:
            Consensus score 0-1
        """
        try:
            markets = self.polymarket.find_related_markets(symbol, "price_movement")
            
            if not markets:
                logger.warning(f"No prediction markets found for {symbol}")
                return 0.5
            
            # Get weighted average of top 3 markets
            weights = [0.5, 0.3, 0.2]  # Weight recent/liquid markets higher
            total_score = 0.0
            
            for i, market in enumerate(markets[:3]):
                odds = self.polymarket.get_market_odds(market["id"])
                if odds:
                    weight = weights[i] if i < len(weights) else 0.1
                    total_score += odds.get("yes", 0.5) * weight
            
            consensus = total_score
            logger.debug(f"{symbol} market consensus: {consensus:.0%}")
            return consensus
            
        except Exception as e:
            logger.warning(f"Prediction market analysis failed: {e}")
            return 0.5

    async def _calculate_risk_reward(self, symbol: str) -> float:
        """
        Calculate risk/reward ratio.
        
        Returns:
            Ratio (1.0 = neutral, >1.5 = good opportunity, <0.5 = poor)
        """
        try:
            # Simplified: Use Polymarket price movements as proxy
            # In production, would use actual option pricing, volatility, etc.
            
            markets = self.polymarket.find_related_markets(symbol, "price_movement")
            
            if not markets:
                return 1.0  # Neutral
            
            # Get price range from top 2 markets
            # Wide range = high volatility = good risk/reward
            odds_list = []
            for market in markets[:2]:
                odds = self.polymarket.get_market_odds(market["id"])
                if odds:
                    odds_list.append(odds.get("yes", 0.5))
            
            if not odds_list:
                return 1.0
            
            # Risk/reward = spread / average_price
            spread = max(odds_list) - min(odds_list)
            avg_price = sum(odds_list) / len(odds_list)
            
            risk_reward = spread / max(avg_price, 0.1)
            
            # Cap at reasonable values
            return min(max(risk_reward, 0.5), 3.0)
            
        except Exception as e:
            logger.warning(f"Risk/reward calculation failed: {e}")
            return 1.0
    
    def _track_execution_metric(self, metric_name: str, value: float):
        """
        Track execution metrics like the $270k crypto trader does.
        
        This allows us to measure our real edge:
        - Speed of signal-to-execution
        - Fill times
        - Latency consistency
        """
        if metric_name not in self.execution_metrics:
            self.execution_metrics[metric_name] = []
        
        metrics = self.execution_metrics[metric_name]
        metrics.append(value)
        
        # Keep last 100 measurements
        if len(metrics) > 100:
            metrics.pop(0)
        
        # Log if it's getting slow
        if metric_name in ["scan_duration", "format_duration_ms"]:
            avg = sum(metrics) / len(metrics)
            if metric_name == "scan_duration" and avg > 10:  # 10 seconds is slow
                logger.warning(f"⚠️  Scan duration trending high: {avg:.2f}s avg")
            if metric_name == "format_duration_ms" and avg > 500:  # 500ms is slow
                logger.warning(f"⚠️  Format duration trending high: {avg:.0f}ms avg")
    
    def get_execution_metrics(self) -> Dict[str, Any]:
        """
        Return execution metrics for dashboard display.
        Shows how fast we're executing vs crypto traders.
        """
        metrics_summary = {}
        
        for metric_name, values in self.execution_metrics.items():
            if values:
                metrics_summary[metric_name] = {
                    "current": values[-1],
                    "average": sum(values) / len(values),
                    "min": min(values),
                    "max": max(values),
                    "samples": len(values)
                }
        
        return metrics_summary

    def _generate_openclaw_signal(
        self,
        symbol: str,
        trend_score: float,
        prediction_score: float,
        risk_reward: float
    ) -> Dict[str, Any]:
        """
        Generate autonomous trading signal.
        
        Combines:
        - Technical trend (40%)
        - Prediction market (40%)
        - Risk/reward (20%)
        """
        # Calculate combined confidence score
        confidence = (
            trend_score * 0.40 +
            prediction_score * 0.40 +
            (risk_reward / 3.0) * 0.20  # Normalize risk_reward to 0-1
        )
        
        # Determine action based on confidence
        if confidence >= 0.70:  # High confidence buy
            action = "BUY"
            reason = f"Strong signal: trend={trend_score:.0%}, prediction={prediction_score:.0%}, R/R={risk_reward:.2f}"
        elif confidence <= 0.30:  # High confidence sell/short
            action = "SELL"
            reason = f"Bearish signal: trend={trend_score:.0%}, prediction={prediction_score:.0%}, R/R={risk_reward:.2f}"
        else:  # Neutral - skip
            action = "SKIP"
            reason = f"Neutral signal: confidence={confidence:.0%} below threshold"
        
        return {
            "symbol": symbol,
            "action": action,
            "confidence": confidence,
            "reason": reason,
            "trend_score": trend_score,
            "prediction_score": prediction_score,
            "risk_reward": risk_reward,
            "timestamp": datetime.now().isoformat(),
            "source": "OPENCLAW"
        }

    async def scan_top_symbols(self, symbols: List[str]) -> List[Dict[str, Any]]:
        """
        Scan multiple symbols for trading opportunities.
        OPTIMIZED: This is the PRIMARY revenue engine - runs every 30 seconds.
        
        Discord alerts are bonus. OpenClaw consistency is the real money.
        
        Args:
            symbols: List of symbols to analyze (e.g., ["AAPL", "TSLA", "BTC", "SPY"])
            
        Returns:
            List of signals for symbols with confidence > 55%
        """
        scan_start = datetime.now()
        logger.info(f"🧠 OpenClaw PRIMARY SCAN: {len(symbols)} symbols")
        
        signals = []
        for symbol in symbols:
            signal = await self.analyze_market(symbol)
            
            # Lower threshold for OpenClaw (we validate with Polymarket)
            # Since this is our main revenue engine, be more aggressive
            if signal.get("confidence", 0) > 0.55:
                signals.append(signal)
            
            # Track scan timing (faster = better)
            await asyncio.sleep(0.2)  # Reduced from 0.5 for speed
        
        scan_duration = (datetime.now() - scan_start).total_seconds()
        logger.info(
            f"📊 OpenClaw scan complete: {len(signals)} opportunities found in {scan_duration:.2f}s"
        )
        
        # Store execution metrics
        self._track_execution_metric("scan_duration", scan_duration)
        
        return signals

    def format_signal_for_execution(self, signal: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert OpenClaw signal to execution format.
        OPTIMIZED for speed - minimize processing time.
        
        This runs on hot path: signal → execution (target: <2 seconds total)
        
        Returns:
            Data ready for trade executor
        """
        confidence = signal.get("confidence", 0)
        execution_start = datetime.now()
        
        # Map confidence to position multiplier
        # Higher multiplier for OpenClaw since it's our primary revenue engine
        if confidence > 0.75:
            multiplier = 2.0  # Increased from 1.5 - OpenClaw is the main engine
        elif confidence > 0.65:
            multiplier = 1.5  # Increased from 1.0
        else:
            multiplier = 1.0  # Increased from 0.5
        
        execution_data = {
            "symbol": signal.get("symbol"),
            "action": "BUY" if "BUY" in signal.get("action", "") else "SELL",
            "source": "openclaw",
            "confidence": confidence,
            "position_multiplier": multiplier,
            "raw_signal": signal,
            "analyzed_at": signal.get("analyzed_at"),
            "format_timestamp": execution_start.isoformat()
        }
        
        # Track formatting time
        format_duration = (datetime.now() - execution_start).total_seconds() * 1000
        self._track_execution_metric("format_duration_ms", format_duration)
        
        return execution_data
