"""
DAILY PROFIT STRATEGY - Learned from losses

GOAL: Make profit EVERY DAY by:
1. Take profit FAST (don't wait for peak)
2. Cut losers IMMEDIATELY
3. Move to NEXT opportunity
4. Protect capital ALWAYS
"""

class DailyProfitStrategy:
    """
    TODAY'S LESSON: We held positions too long, missed peaks, took losses
    
    NEW STRATEGY:
    - Take profit at +1% (small but consistent)
    - Cut loss at -1% (protect capital)
    - Move on FAST to next opportunity
    - 10-20 trades/day = compound profits
    """
    
    # AGGRESSIVE PROFIT TAKING
    PROFIT_TARGET = 1.0      # Exit at +1% (don't be greedy)
    STOP_LOSS = -1.0         # Cut at -1% (protect capital)
    
    # TRAILING STOP (lock profits)
    TRAILING_STOP_PCT = 0.25  # Exit if drops 25% from peak
    
    # FAST ROTATION
    MAX_HOLD_TIME = 15       # 15 min max (move on fast)
    
    @staticmethod
    def should_exit(pos: dict, hold_minutes: float, trend_score: float) -> tuple[bool, str]:
        """
        Exit decision with DIFFERENT rules for OPTIONS vs STOCKS
        
        OPTIONS: Let them run (10-20% targets)
        STOCKS: Quick profits (1-2% targets)
        """
        pnl_pct = pos.get('pnl_pct', 0)
        peak_pnl = pos.get('peak_pnl', pnl_pct)
        is_option = pos.get('type') == 'OPTION'
        
        # STOP LOSS (different for options vs stocks)
        stop_loss = -3.0 if is_option else -1.0  # Options can handle more risk
        if pnl_pct <= stop_loss:
            return True, f"STOP LOSS {pnl_pct:.1f}%"
        
        # OPENCLAW STRONG TREND - Always hold
        if trend_score > 0.65:
            return False, f"TREND STRONG ({trend_score:.0%}) - HOLDING"
        
        # PROFIT TARGETS (different for options vs stocks)
        if is_option:
            # OPTIONS: Target 10%+ (they move fast)
            if pnl_pct >= 10.0:
                return True, f"OPTION PROFIT +{pnl_pct:.1f}%"
        else:
            # STOCKS: Target 1%+ (smaller moves)
            if pnl_pct >= 1.0:
                return True, f"STOCK PROFIT +{pnl_pct:.1f}%"
        
        # TRAILING STOP (tighter for options)
        if is_option and peak_pnl > 5.0:
            # Options: Exit if drops 40% from peak
            drop_from_peak = peak_pnl - pnl_pct
            if drop_from_peak > peak_pnl * 0.4:
                return True, f"OPTION TRAILING: Peak {peak_pnl:.1f}% → {pnl_pct:.1f}%"
        elif not is_option and peak_pnl > 0.5:
            # Stocks: Exit if drops 25% from peak
            drop_from_peak = peak_pnl - pnl_pct
            if drop_from_peak > peak_pnl * 0.25:
                return True, f"STOCK TRAILING: Peak {peak_pnl:.1f}% → {pnl_pct:.1f}%"
        
        # WEAK TREND - Exit
        if trend_score < 0.45:
            return True, f"WEAK TREND ({trend_score:.0%})"
        
        # TIME LIMIT (longer for options)
        max_time = 30 if is_option else 15  # Options get 30min, stocks 15min
        if hold_minutes >= max_time and trend_score < 0.60:
            return True, f"TIME LIMIT {hold_minutes:.0f}min"
        
        return False, f"HOLDING (trend {trend_score:.0%})"
    
    @staticmethod
    def get_daily_summary(trades: list) -> dict:
        """Calculate daily profit summary"""
        closed_trades = [t for t in trades if t.get('status') == 'CLOSED']
        
        total_pnl = sum(t.get('pnl', 0) for t in closed_trades)
        winners = [t for t in closed_trades if t.get('pnl', 0) > 0]
        losers = [t for t in closed_trades if t.get('pnl', 0) < 0]
        
        return {
            'total_trades': len(closed_trades),
            'total_pnl': total_pnl,
            'winners': len(winners),
            'losers': len(losers),
            'win_rate': len(winners) / len(closed_trades) if closed_trades else 0,
            'avg_win': sum(t['pnl'] for t in winners) / len(winners) if winners else 0,
            'avg_loss': sum(t['pnl'] for t in losers) / len(losers) if losers else 0
        }
