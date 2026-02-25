"""
Latency monitor to track loop times and alert on delays.
"""
import time
from collections import deque
from src.utils import logger


class LatencyMonitor:
    """Monitor loop execution times and alert on delays."""
    
    def __init__(self, max_latency_seconds: float = 10.0):
        self.max_latency = max_latency_seconds
        self.loop_times = deque(maxlen=100)
        self.alert_count = 0
        
    def start_loop(self) -> float:
        """Mark start of loop iteration."""
        return time.time()
    
    def end_loop(self, start_time: float) -> float:
        """
        Mark end of loop iteration and check latency.
        Returns loop duration in seconds.
        """
        duration = time.time() - start_time
        self.loop_times.append(duration)
        
        if duration > self.max_latency:
            self.alert_count += 1
            logger.warning(
                f"⚠️ High latency detected: {duration:.2f}s "
                f"(threshold: {self.max_latency}s) - Alert #{self.alert_count}"
            )
            
            if self.alert_count >= 3:
                logger.error(
                    "🚨 CRITICAL: Multiple high-latency loops detected. "
                    "Check IBKR connection and system resources."
                )
        
        return duration
    
    def get_stats(self) -> dict:
        """Get latency statistics."""
        if not self.loop_times:
            return {
                'avg_latency': 0,
                'max_latency': 0,
                'min_latency': 0,
                'alert_count': self.alert_count
            }
        
        return {
            'avg_latency': sum(self.loop_times) / len(self.loop_times),
            'max_latency': max(self.loop_times),
            'min_latency': min(self.loop_times),
            'alert_count': self.alert_count
        }
    
    def reset_alerts(self):
        """Reset alert counter."""
        self.alert_count = 0


# Global instance
_latency_monitor = None

def get_latency_monitor():
    """Get singleton latency monitor."""
    global _latency_monitor
    if _latency_monitor is None:
        _latency_monitor = LatencyMonitor(max_latency_seconds=10.0)
    return _latency_monitor
