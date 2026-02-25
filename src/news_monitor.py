"""
News and economic event monitor to pause trading during high-impact events.
"""
from datetime import datetime, timedelta
import requests
from typing import List, Dict
from src.utils import logger


class NewsMonitor:
    """Monitor economic events and pause trading during high-impact releases."""
    
    def __init__(self):
        self.high_impact_events = []
        self.last_fetch = None
        
    def fetch_economic_calendar(self) -> List[Dict]:
        """Fetch today's economic events (using free API or fallback)."""
        try:
            # Using investing.com calendar or similar free API
            # For now, hardcode common high-impact times (can be enhanced)
            now = datetime.now()
            
            # Common high-impact times (ET):
            # - 8:30 AM: Jobs report, CPI, GDP
            # - 10:00 AM: ISM, Consumer Confidence
            # - 2:00 PM: FOMC announcements
            
            high_impact_times = [
                (8, 30),   # 8:30 AM
                (10, 0),   # 10:00 AM
                (14, 0),   # 2:00 PM
            ]
            
            events = []
            for hour, minute in high_impact_times:
                event_time = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                events.append({
                    'time': event_time,
                    'impact': 'HIGH',
                    'title': 'Economic Release'
                })
            
            self.high_impact_events = events
            self.last_fetch = now
            return events
            
        except Exception as e:
            logger.error(f"Failed to fetch economic calendar: {e}")
            return []
    
    def should_pause_trading(self, pause_window_minutes: int = 30) -> tuple[bool, str]:
        """
        Check if trading should be paused due to upcoming/ongoing event.
        Returns (should_pause, reason).
        """
        now = datetime.now()
        
        # Refresh calendar if needed (once per day)
        if self.last_fetch is None or (now - self.last_fetch).days >= 1:
            self.fetch_economic_calendar()
        
        # Check if within pause window of any high-impact event
        for event in self.high_impact_events:
            event_time = event['time']
            time_diff = abs((now - event_time).total_seconds() / 60)
            
            if time_diff <= pause_window_minutes:
                return True, f"High-impact event at {event_time.strftime('%H:%M')} ({event['title']})"
        
        return False, "Clear to trade"
    
    def get_next_event(self) -> Dict:
        """Get next upcoming high-impact event."""
        now = datetime.now()
        
        upcoming = [e for e in self.high_impact_events if e['time'] > now]
        if upcoming:
            return min(upcoming, key=lambda x: x['time'])
        return None


# Global instance
_news_monitor = None

def get_news_monitor():
    """Get singleton news monitor."""
    global _news_monitor
    if _news_monitor is None:
        _news_monitor = NewsMonitor()
    return _news_monitor
