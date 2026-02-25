"""
Enhanced audit logging for detailed trade metrics and post-mortem analysis.
"""
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, Any


class AuditLogger:
    """Enhanced logging for trade metrics and diversification stats."""
    
    def __init__(self):
        self.log_dir = Path('logs')
        self.log_dir.mkdir(exist_ok=True)
        
    def log_trade(self, trade_data: Dict[str, Any]):
        """Log detailed trade information."""
        today = datetime.now().strftime('%Y-%m-%d')
        log_file = self.log_dir / f'audit_{today}.jsonl'
        
        # Enhanced trade record
        record = {
            'timestamp': datetime.now().isoformat(),
            'symbol': trade_data.get('symbol'),
            'action': trade_data.get('action'),
            'quantity': trade_data.get('quantity'),
            'entry_price': trade_data.get('entry_price'),
            'exit_price': trade_data.get('exit_price'),
            'pnl': trade_data.get('pnl'),
            'pnl_pct': trade_data.get('pnl_pct'),
            'hold_time_minutes': trade_data.get('hold_time_minutes'),
            'exit_reason': trade_data.get('exit_reason'),
            'openclaw_score': trade_data.get('openclaw_score'),
            'polymarket_score': trade_data.get('polymarket_score'),
            'combined_confidence': trade_data.get('combined_confidence'),
            'sector': trade_data.get('sector'),
            'atr': trade_data.get('atr'),
            'volume_ratio': trade_data.get('volume_ratio'),
            'signal_mode': trade_data.get('signal_mode', 'DUAL')
        }
        
        # Append to JSONL file
        with open(log_file, 'a') as f:
            f.write(json.dumps(record) + '\n')
    
    def log_daily_summary(self, summary_data: Dict[str, Any]):
        """Log end-of-day summary with diversification stats."""
        today = datetime.now().strftime('%Y-%m-%d')
        summary_file = self.log_dir / f'summary_{today}.json'
        
        summary = {
            'date': today,
            'total_trades': summary_data.get('total_trades', 0),
            'wins': summary_data.get('wins', 0),
            'losses': summary_data.get('losses', 0),
            'win_rate': summary_data.get('win_rate', 0),
            'total_pnl': summary_data.get('total_pnl', 0),
            'starting_balance': summary_data.get('starting_balance', 0),
            'ending_balance': summary_data.get('ending_balance', 0),
            'return_pct': summary_data.get('return_pct', 0),
            'max_drawdown': summary_data.get('max_drawdown', 0),
            'sectors_traded': summary_data.get('sectors_traded', []),
            'avg_hold_time': summary_data.get('avg_hold_time', 0),
            'openclaw_accuracy': summary_data.get('openclaw_accuracy', 0),
            'polymarket_accuracy': summary_data.get('polymarket_accuracy', 0),
            'fallback_count': summary_data.get('fallback_count', 0),
            'circuit_breaker_triggered': summary_data.get('circuit_breaker_triggered', False)
        }
        
        with open(summary_file, 'w') as f:
            json.dump(summary, f, indent=2)
    
    def get_performance_metrics(self, days: int = 7) -> Dict[str, Any]:
        """Analyze last N days of trading for ML-lite weight adjustment."""
        metrics = {
            'openclaw_wins': 0,
            'openclaw_total': 0,
            'polymarket_wins': 0,
            'polymarket_total': 0,
            'total_trades': 0,
            'avg_return': 0
        }
        
        # Read last N days of audit logs
        for i in range(days):
            date = (datetime.now() - timedelta(days=i)).strftime('%Y-%m-%d')
            log_file = self.log_dir / f'audit_{date}.jsonl'
            
            if not log_file.exists():
                continue
            
            with open(log_file, 'r') as f:
                for line in f:
                    try:
                        trade = json.loads(line)
                        pnl = trade.get('pnl', 0)
                        
                        # Track OpenClaw accuracy
                        if trade.get('openclaw_score', 0) > 0.6:
                            metrics['openclaw_total'] += 1
                            if pnl > 0:
                                metrics['openclaw_wins'] += 1
                        
                        # Track Polymarket accuracy
                        if trade.get('polymarket_score', 0) > 0.6:
                            metrics['polymarket_total'] += 1
                            if pnl > 0:
                                metrics['polymarket_wins'] += 1
                        
                        metrics['total_trades'] += 1
                        
                    except:
                        continue
        
        # Calculate accuracies
        if metrics['openclaw_total'] > 0:
            metrics['openclaw_accuracy'] = metrics['openclaw_wins'] / metrics['openclaw_total']
        
        if metrics['polymarket_total'] > 0:
            metrics['polymarket_accuracy'] = metrics['polymarket_wins'] / metrics['polymarket_total']
        
        return metrics


# Global instance
_audit_logger = None

def get_audit_logger():
    """Get singleton audit logger."""
    global _audit_logger
    if _audit_logger is None:
        _audit_logger = AuditLogger()
    return _audit_logger


from datetime import timedelta
