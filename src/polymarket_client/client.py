"""
Polymarket API client using official CLOB, Data, and Gamma APIs.
Provides prediction market analysis for stock trading decisions.
"""

import requests
from typing import Optional, Dict, List, Any
from src.utils import logger
from src.config import settings


class PolymarketClient:
    """Client for Polymarket prediction markets using official APIs."""

    CLOB_API = "https://clob.polymarket.com"
    DATA_API = "https://data-api.polymarket.com"
    GAMMA_API = "https://gamma-api.polymarket.com"

    def __init__(self):
        self.session = requests.Session()
        self.headers = {"Content-Type": "application/json"}
        logger.info("PolymarketClient initialized with official APIs")

    def search_markets(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Search markets using Gamma API."""
        try:
            url = f"{self.GAMMA_API}/markets"
            params = {"active": "true", "closed": "false", "limit": limit}
            
            response = self.session.get(url, params=params, headers=self.headers, timeout=10)
            response.raise_for_status()
            
            markets = response.json()
            # Filter by query
            filtered = [m for m in markets if query.upper() in m.get('question', '').upper()]
            logger.info(f"Found {len(filtered)} markets for '{query}'")
            return filtered
            
        except Exception as e:
            logger.error(f"Market search failed: {e}")
            return []

    def get_market_by_slug(self, slug: str) -> Optional[Dict[str, Any]]:
        """Get market details by slug using Gamma API."""
        try:
            url = f"{self.GAMMA_API}/market/slug/{slug}"
            response = self.session.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"Failed to get market {slug}: {e}")
            return None

    def get_orderbook(self, slug: str) -> Optional[Dict[str, Any]]:
        """Get full orderbook using CLOB API."""
        try:
            url = f"{self.CLOB_API}/markets/{slug}/book"
            response = self.session.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"Failed to get orderbook for {slug}: {e}")
            return None

    def get_best_bid_offer(self, slug: str) -> Optional[Dict[str, Any]]:
        """Get best bid/offer using CLOB API."""
        try:
            url = f"{self.CLOB_API}/markets/{slug}/bbo"
            response = self.session.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"Failed to get BBO for {slug}: {e}")
            return None

    def get_price_history(self, slug: str) -> Optional[List[Dict[str, Any]]]:
        """Get price history using CLOB API."""
        try:
            url = f"{self.CLOB_API}/markets/{slug}/prices"
            response = self.session.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"Failed to get price history for {slug}: {e}")
            return None

    def get_market_trades(self, market_id: str) -> Optional[List[Dict[str, Any]]]:
        """Get market trades using Data API."""
        try:
            url = f"{self.DATA_API}/trades/market/{market_id}"
            response = self.session.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"Failed to get trades for {market_id}: {e}")
            return None

    def get_open_interest(self, market_id: str) -> Optional[Dict[str, Any]]:
        """Get open interest using Data API."""
        try:
            url = f"{self.DATA_API}/open-interest/{market_id}"
            response = self.session.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"Failed to get open interest for {market_id}: {e}")
            return None

    def analyze_stock_sentiment(self, symbol: str) -> Dict[str, Any]:
        """Analyze stock sentiment from prediction markets."""
        try:
            # Search for stock-related markets
            markets = self.search_markets(symbol, limit=5)
            
            if not markets:
                return {"probability": 0.5, "confidence": 0, "markets_found": 0}
            
            # Analyze each market
            total_prob = 0
            total_volume = 0
            analyzed = 0
            
            for market in markets:
                slug = market.get('slug')
                if not slug:
                    continue
                
                # Get BBO for current price
                bbo = self.get_best_bid_offer(slug)
                if bbo:
                    # Get YES price (probability)
                    yes_price = bbo.get('yes', {}).get('price', 0.5)
                    volume = market.get('volume', 0)
                    
                    total_prob += yes_price * (volume + 1)  # Weight by volume
                    total_volume += (volume + 1)
                    analyzed += 1
            
            if analyzed == 0:
                return {"probability": 0.5, "confidence": 0, "markets_found": 0}
            
            # Weighted average probability
            avg_prob = total_prob / total_volume if total_volume > 0 else 0.5
            confidence = min(100, analyzed * 20)  # More markets = higher confidence
            
            logger.info(f"{symbol}: {analyzed} markets, {avg_prob:.1%} bullish, {confidence}% confidence")
            
            return {
                "probability": avg_prob,
                "confidence": confidence,
                "markets_found": analyzed,
                "total_volume": total_volume
            }
            
        except Exception as e:
            logger.error(f"Stock sentiment analysis failed for {symbol}: {e}")
            return {"probability": 0.5, "confidence": 0, "markets_found": 0}

    def get_market_probability(self, symbol: str, direction: str) -> float:
        """Get probability for stock direction from prediction markets."""
        analysis = self.analyze_stock_sentiment(symbol)
        prob = analysis.get('probability', 0.5)
        
        if direction == "up":
            return prob
        else:
            return 1 - prob

    def find_related_markets(self, symbol: str, signal_type: str) -> List[Dict[str, Any]]:
        """Find prediction markets related to a stock symbol."""
        return self.search_markets(symbol, limit=5)
