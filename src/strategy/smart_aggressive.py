"""Smart Aggressive Strategy - Fast profits, minimal risk"""

class SmartAggressiveStrategy:
    # ENTRY
    MIN_MOVE_STOCK = 0.5
    MIN_MOVE_OPTION = 1.2
    
    # EXIT (AGGRESSIVE)
    PROFIT_TARGET_STOCK = 1.5
    PROFIT_TARGET_OPTION = 8.0
    STOP_LOSS = -2.0
    
    # TIME (FAST ROTATION)
    MAX_HOLD_STOCK = 20  # 20 min
    MAX_HOLD_OPTION = 15 # 15 min
    
    # SIZE (MINIMAL RISK)
    STOCK_SIZE = 0.10  # 10%
    OPTION_SIZE = 0.05 # 5%
    MAX_POSITIONS = 6
    
    @staticmethod
    def should_enter(change_pct: float, positions_count: int):
        if positions_count >= SmartAggressiveStrategy.MAX_POSITIONS:
            return False, None
        if abs(change_pct) >= SmartAggressiveStrategy.MIN_MOVE_OPTION:
            return True, 'OPTION'
        if abs(change_pct) >= SmartAggressiveStrategy.MIN_MOVE_STOCK:
            return True, 'STOCK'
        return False, None
    
    @staticmethod
    def should_exit(position: dict, hold_minutes: float):
        pnl_pct = position.get('pnl_pct', 0)
        pos_type = position.get('type', 'STOCK')
        
        if pnl_pct <= SmartAggressiveStrategy.STOP_LOSS:
            return True, f"STOP {pnl_pct:.1f}%"
        
        if pos_type == 'OPTION':
            if pnl_pct >= SmartAggressiveStrategy.PROFIT_TARGET_OPTION:
                return True, f"PROFIT +{pnl_pct:.1f}%"
            if hold_minutes >= SmartAggressiveStrategy.MAX_HOLD_OPTION:
                return True, f"TIME {hold_minutes:.0f}min"
        else:
            if pnl_pct >= SmartAggressiveStrategy.PROFIT_TARGET_STOCK:
                return True, f"PROFIT +{pnl_pct:.1f}%"
            if hold_minutes >= SmartAggressiveStrategy.MAX_HOLD_STOCK:
                return True, f"TIME {hold_minutes:.0f}min"
        
        return False, "HOLDING"
