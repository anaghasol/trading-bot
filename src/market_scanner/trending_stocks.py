"""
Dynamic Trending Stocks Scanner
Asks OpenClaw what's hot TODAY, not static list
"""
import yfinance as yf
from datetime import datetime, timedelta
from typing import List, Dict
import asyncio

class TrendingStocksScanner:
    """Find what's moving TODAY"""
    
    def __init__(self):
        # Universe to scan (top liquid stocks)
        self.universe = [
            'SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD',
            'NFLX', 'COIN', 'PLTR', 'SOFI', 'RIVN', 'LCID', 'NIO', 'BABA', 'DIS', 'BA',
            'JPM', 'BAC', 'GS', 'V', 'MA', 'PYPL', 'SQ', 'SHOP', 'UBER', 'LYFT',
            'ABNB', 'DASH', 'SNOW', 'NET', 'DDOG', 'CRWD', 'ZS', 'OKTA', 'MDB', 'TWLO'
        ]
        self.cache = None
        self.cache_time = None
    
    async def get_trending_stocks(self, top_n: int = 10) -> List[str]:
        """
        Get TOP trending stocks RIGHT NOW
        
        Returns:
            List of symbols with highest momentum TODAY
        """
        # Cache for 15 minutes (refresh frequently)
        if self.cache and self.cache_time:
            age = (datetime.now() - self.cache_time).total_seconds()
            if age < 900:  # 15 min
                return self.cache[:top_n]
        
        print(f"🔍 Scanning {len(self.universe)} stocks for trends...")
        
        movers = []
        for symbol in self.universe:
            try:
                ticker = yf.Ticker(symbol)
                hist = ticker.history(period='1d', interval='5m')
                
                if len(hist) < 2:
                    continue
                
                # Calculate momentum (last 30min vs opening)
                current = float(hist['Close'].iloc[-1])
                opening = float(hist['Open'].iloc[0])
                change_pct = ((current - opening) / opening) * 100
                
                # Volume surge (today vs 5-day avg)
                volume_today = hist['Volume'].sum()
                hist_5d = ticker.history(period='5d')
                avg_volume = hist_5d['Volume'].mean() if len(hist_5d) > 0 else 1
                volume_ratio = volume_today / avg_volume if avg_volume > 0 else 1
                
                # Momentum score = price change + volume surge
                momentum = abs(change_pct) * (1 + volume_ratio * 0.5)
                
                movers.append({
                    'symbol': symbol,
                    'change_pct': change_pct,
                    'volume_ratio': volume_ratio,
                    'momentum': momentum,
                    'price': current
                })
                
                await asyncio.sleep(0.1)  # Rate limit
            except Exception as e:
                continue
        
        # Sort by momentum
        movers.sort(key=lambda x: x['momentum'], reverse=True)
        
        # Cache results
        self.cache = [m['symbol'] for m in movers]
        self.cache_time = datetime.now()
        
        top_movers = movers[:top_n]
        print(f"🔥 TOP {top_n} TRENDING:")
        for m in top_movers:
            print(f"   {m['symbol']}: {m['change_pct']:+.2f}% | Vol: {m['volume_ratio']:.1f}x | Score: {m['momentum']:.1f}")
        
        return [m['symbol'] for m in top_movers]

_scanner = None

def get_trending_scanner():
    global _scanner
    if _scanner is None:
        _scanner = TrendingStocksScanner()
    return _scanner
