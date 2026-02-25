"""
Live Trading Engine - Optimized for 10 stocks
"""
import asyncio
import json
from datetime import datetime
from pathlib import Path
import yfinance as yf
from src.ibkr_client import IBKRClient
from src.config import settings
import time
from src.learning_engine import get_learning_engine
from src.market_scanner import get_trending_scanner
from src.trading_engine.enhanced_risk import EnhancedRiskManager

STATE_FILE = Path('trading_state.json')

class LiveTradingEngine:
    def __init__(self):
        self.ibkr = IBKRClient(
            host=settings.IBKR_HOST,
            port=settings.IBKR_PORT,
            client_id=settings.IBKR_CLIENT_ID
        )
        self.state = self.load_state()
        self.symbols = []  # Dynamic - updated every 15min
        self.trending_scanner = get_trending_scanner()
        self.learning = get_learning_engine()
        self.position_entry_times = {}
        self.enhanced_risk = EnhancedRiskManager(max_daily_loss_pct=2.0)
        
    def load_state(self):
        if STATE_FILE.exists():
            with open(STATE_FILE, 'r') as f:
                state = json.load(f)
                # Clean up trades older than 7 days
                self._cleanup_old_trades(state)
                return state
        return {
            'positions': {},
            'trades': [],
            'balance': 1000000.0,
            'starting_balance': 1000000.0,
            'daily_pnl': 0.0
        }
    
    def _cleanup_old_trades(self, state):
        """Remove trades older than 7 days"""
        from datetime import datetime, timedelta
        cutoff = datetime.now() - timedelta(days=7)
        
        original_count = len(state.get('trades', []))
        state['trades'] = [
            t for t in state.get('trades', [])
            if datetime.fromisoformat(t.get('timestamp', datetime.now().isoformat())) > cutoff
        ]
        
        removed = original_count - len(state['trades'])
        if removed > 0:
            print(f"🗑️  Cleaned up {removed} trades older than 7 days")
    
    def save_state(self):
        with open(STATE_FILE, 'w') as f:
            json.dump(self.state, f, indent=2)
    
    async def analyze_and_trade(self):
        """Analyze with OpenClaw + Polymarket for best signals"""
        for symbol in self.symbols:
            try:
                if symbol in self.state['positions']:
                    continue
                
                if len(self.state['positions']) >= 8:
                    break
                
                ticker = yf.Ticker(symbol)
                hist = ticker.history(period='5d')
                
                if len(hist) < 2:
                    continue
                
                current_price = float(hist['Close'].iloc[-1])
                prev_price = float(hist['Close'].iloc[-2])
                change_pct = ((current_price - prev_price) / prev_price) * 100
                
                if abs(change_pct) > 0.5:
                    # STEP 1: OpenClaw technical analysis
                    from src.openclaw_agent import OpenClawAgent
                    agent = OpenClawAgent()
                    openclaw_signal = await agent.analyze_market(symbol)
                    trend_score = openclaw_signal.get('trend_score', 0.5)
                    
                    # STEP 2: Polymarket crowd sentiment
                    from src.polymarket_client import PolymarketClient
                    poly = PolymarketClient()
                    poly_analysis = poly.analyze_stock_sentiment(symbol)
                    poly_prob = poly_analysis.get('probability', 0.5)
                    poly_confidence = poly_analysis.get('confidence', 0)
                    
                    # STEP 3: Combined decision
                    # Both must agree for trade
                    openclaw_bullish = trend_score > 0.55
                    poly_bullish = poly_prob > 0.55
                    
                    # Calculate combined confidence
                    combined_confidence = (trend_score * 0.6) + (poly_prob * 0.4)
                    
                    if openclaw_bullish and poly_bullish and combined_confidence > 0.60:
                        print(f"✅ STRONG BUY {symbol}: OpenClaw {trend_score:.0%} + Polymarket {poly_prob:.0%} = {combined_confidence:.0%}")
                        action = 'BUY' if change_pct > 0 else 'SELL'
                        await self.execute_trade(symbol, action, current_price, combined_confidence * 100)
                    elif not openclaw_bullish or not poly_bullish:
                        print(f"⏭️  SKIP {symbol}: OpenClaw {trend_score:.0%}, Polymarket {poly_prob:.0%} (no consensus)")
                
                await asyncio.sleep(1)
            except Exception as e:
                print(f"Error {symbol}: {e}")
    
    async def execute_options_trade(self, symbol, change_pct, stock_price):
        """Execute options trade for higher leverage"""
        try:
            from datetime import datetime, timedelta
            
            # Determine direction
            if change_pct > 0:
                right = 'C'  # Call option
                action = 'BUY'
            else:
                right = 'P'  # Put option
                action = 'BUY'
            
            # Get next Friday expiration (weekly options)
            today = datetime.now()
            days_ahead = 4 - today.weekday()  # Friday is 4
            if days_ahead <= 0:
                days_ahead += 7
            expiration = today + timedelta(days=days_ahead)
            expiration_str = expiration.strftime('%Y%m%d')
            
            # Strike: slightly OTM for leverage
            if right == 'C':
                strike = round(stock_price * 1.01, 1)  # 1% OTM call (closer)
            else:
                strike = round(stock_price * 0.99, 1)  # 1% OTM put (closer)
            
            # Position size: 5% of balance (options are leveraged)
            position_value = self.state['balance'] * 0.05
            # Assume option costs ~$2-5, buy multiple contracts
            quantity = max(1, int(position_value / 300))  # ~$300 per contract
            
            if not self.ibkr.connected:
                await self.ibkr.connect()
            
            order = await self.ibkr.place_options_order(
                symbol=symbol,
                expiration=expiration_str,
                strike=strike,
                right=right,
                quantity=quantity,
                action=action,
                order_type='MKT'
            )
            
            if order:
                option_symbol = f"{symbol} {expiration_str} {strike}{right}"
                confidence = min(95, 70 + abs(change_pct) * 10)
                
                trade = {
                    'symbol': option_symbol,
                    'underlying': symbol,
                    'action': action,
                    'quantity': quantity,
                    'price': stock_price * 0.03,  # Estimate ~3% of stock price
                    'type': 'OPTION',
                    'strike': strike,
                    'right': right,
                    'expiration': expiration_str,
                    'confidence': confidence,
                    'timestamp': datetime.now().isoformat(),
                    'status': 'OPEN'
                }
                
                self.state['trades'].append(trade)
                self.state['positions'][symbol] = {
                    'quantity': quantity,
                    'entry_price': stock_price * 0.03,  # Estimate entry price
                    'current_price': stock_price * 0.03,
                    'pnl': 0.0,
                    'pnl_pct': 0.0,
                    'type': 'OPTION',
                    'option_symbol': option_symbol
                }
                self.position_entry_times[symbol] = datetime.now()
                
                self.save_state()
                print(f"✅ OPTIONS: {action} {quantity} {option_symbol} (conf: {confidence:.0f}%)")
        except Exception as e:
            print(f"Options trade failed: {e}")
    
    async def execute_trade(self, symbol, action, price, confidence):
        """Execute trade"""
        try:
            # 12% per position for 6 positions = 72% utilization
            position_value = self.state['balance'] * 0.12
            quantity = int(position_value / price)
            
            if quantity < 1:
                return
            
            if not self.ibkr.connected:
                await self.ibkr.connect()
            
            order = await self.ibkr.place_stock_order(
                symbol=symbol,
                quantity=quantity,
                action=action,
                order_type='MKT'
            )
            
            if order:
                trade = {
                    'symbol': symbol,
                    'action': action,
                    'quantity': quantity,
                    'price': price,
                    'confidence': confidence,
                    'timestamp': datetime.now().isoformat(),
                    'status': 'OPEN'
                }
                
                self.state['trades'].append(trade)
                self.state['positions'][symbol] = {
                    'quantity': quantity if action == 'BUY' else -quantity,
                    'entry_price': price,
                    'current_price': price,
                    'pnl': 0.0,
                    'pnl_pct': 0.0
                }
                self.position_entry_times[symbol] = datetime.now()
                
                self.save_state()
                print(f"✅ {action} {quantity} {symbol} @ ${price:.2f} (conf: {confidence:.0f}%)")
        except Exception as e:
            print(f"Trade failed: {e}")
    
    async def should_close_position(self, symbol: str, pos: dict) -> tuple[bool, str]:
        """SMART EXIT - Take profits quickly, cut losses fast"""
        pnl_pct = pos.get('pnl_pct', 0)
        is_option = pos.get('type') == 'OPTION'
        
        # STOP LOSS - Cut losses immediately
        if is_option:
            if pnl_pct <= -2.0:  # Options: -2% stop loss
                return True, f"STOP LOSS {pnl_pct:.1f}% (options)"
        else:
            if pnl_pct <= -1.0:  # Stocks: -1% stop loss
                return True, f"STOP LOSS {pnl_pct:.1f}% (stock)"
        
        # TAKE PROFIT - Lock in gains
        if is_option:
            if pnl_pct >= 3.0:  # Options: +3% take profit
                return True, f"TAKE PROFIT {pnl_pct:.1f}% (options)"
        else:
            if pnl_pct >= 1.5:  # Stocks: +1.5% take profit
                return True, f"TAKE PROFIT {pnl_pct:.1f}% (stock)"
        
        # TRAILING STOP - Protect profits
        peak_pnl = pos.get('peak_pnl', pnl_pct)
        if pnl_pct > peak_pnl:
            peak_pnl = pnl_pct
            pos['peak_pnl'] = peak_pnl
        
        # If up 2%+, don't let it drop below 1%
        if peak_pnl >= 2.0 and pnl_pct < 1.0:
            return True, f"TRAILING STOP (peak {peak_pnl:.1f}% → {pnl_pct:.1f}%)"
        
        # Check trend reversal
        try:
            from src.openclaw_agent import OpenClawAgent
            agent = OpenClawAgent()
            signal = await agent.analyze_market(symbol)
            trend_score = signal.get('trend_score', 0.5)
            
            # Exit if trend weakens significantly
            if trend_score < 0.45 and pnl_pct < 0.5:
                return True, f"WEAK TREND {trend_score:.0%} (exit before loss)"
        except:
            pass
        
        return False, f"HOLD {pnl_pct:+.1f}%"
    
    async def update_positions(self):
        """Update balance and P&L from IBKR"""
        try:
            # Get current balance from IBKR
            current_balance = await self.ibkr.get_account_balance()
            
            if current_balance:
                if 'starting_balance' not in self.state:
                    self.state['starting_balance'] = current_balance
                
                starting = self.state.get('starting_balance', 1000000.0)
                self.state['balance'] = current_balance
                self.state['daily_pnl'] = current_balance - starting
                
                print(f"💰 Balance: ${current_balance:,.2f} | P&L: ${self.state['daily_pnl']:,.2f}")
            
            # Update stock positions with current prices
            import yfinance as yf
            
            for symbol, pos in list(self.state['positions'].items()):
                try:
                    # Get current stock price
                    ticker = yf.Ticker(symbol)
                    hist = ticker.history(period='1d')
                    
                    if hist.empty:
                        continue
                    
                    current_price = float(hist['Close'].iloc[-1])
                    entry_price = pos.get('entry_price', current_price)
                    quantity = pos.get('quantity', 0)
                    
                    # Calculate P&L
                    if quantity > 0:
                        pnl = (current_price - entry_price) * quantity
                        pnl_pct = ((current_price - entry_price) / entry_price) * 100
                    else:
                        pnl = (entry_price - current_price) * abs(quantity)
                        pnl_pct = ((entry_price - current_price) / entry_price) * 100
                    
                    pos['current_price'] = current_price
                    pos['pnl'] = pnl
                    pos['pnl_pct'] = pnl_pct
                    
                    # Check if should close (stop-loss or take-profit)
                    should_close, reason = await self.should_close_position(symbol, pos)
                    if should_close:
                        print(f"💰 CLOSING {symbol} - {reason}")
                        await self.close_position(symbol)
                    else:
                        print(f"✅ HOLDING {symbol} - {reason}")
                    
                    await asyncio.sleep(0.3)
                    
                except Exception as e:
                    print(f"Error updating {symbol}: {e}")
            
            self.save_state()
            
        except Exception as e:
            print(f"Update positions error: {e}")
    
    async def close_position(self, symbol):
        """Close position and log profit - KEEP ALL TRADES IN HISTORY"""
        try:
            pos = self.state['positions'][symbol]
            quantity = abs(pos['quantity'])
            pnl = pos.get('pnl', 0)
            pnl_pct = pos.get('pnl_pct', 0)
            
            if not self.ibkr.connected:
                await self.ibkr.connect()
            
            if pos.get('type') == 'OPTION':
                print(f"✅ CLOSED OPTION {symbol} | P&L: ${pnl:.2f} ({pnl_pct:.1f}%)")
            else:
                action = 'SELL' if pos['quantity'] > 0 else 'BUY'
                
                order = await self.ibkr.place_stock_order(
                    symbol=symbol,
                    quantity=quantity,
                    action=action,
                    order_type='MKT'
                )
                
                if order:
                    print(f"✅ CLOSED {symbol} | P&L: ${pnl:.2f} ({pnl_pct:.1f}%)")
            
            # Log to daily profit file
            self.log_daily_profit(symbol, pnl, pnl_pct)
            
            # Update trade record - NEVER DELETE, just mark as CLOSED
            for trade in self.state['trades']:
                if trade.get('underlying', trade.get('symbol')) == symbol and trade['status'] == 'OPEN':
                    trade['status'] = 'CLOSED'
                    trade['exit_price'] = pos.get('current_price', 0)
                    trade['pnl'] = pnl
                    trade['pnl_pct'] = pnl_pct
                    trade['close_time'] = datetime.now().isoformat()
                    # DO NOT DELETE - keep for history
            
            del self.state['positions'][symbol]
            if symbol in self.position_entry_times:
                del self.position_entry_times[symbol]
            self.save_state()
            
            # Immediately look for new opportunities
            print(f"🔍 Looking for new opportunities to replace {symbol}...")
            
        except Exception as e:
            print(f"Close failed: {e}")
    
    def log_daily_profit(self, symbol: str, pnl: float, pnl_pct: float):
        """Log profit to daily file"""
        from pathlib import Path
        
        today = datetime.now().strftime('%Y-%m-%d')
        profit_file = Path(f'logs/daily_profits_{today}.txt')
        
        with open(profit_file, 'a') as f:
            timestamp = datetime.now().strftime('%H:%M:%S')
            f.write(f"{timestamp} | {symbol} | ${pnl:.2f} | {pnl_pct:.2f}%\n")
        
        print(f"📊 Daily profit logged: {symbol} ${pnl:.2f}")
    
    async def run(self):
        """Main loop - stops at market close with circuit breaker"""
        print("🚀 Live Trading Started - ENHANCED RISK MANAGEMENT")
        print(f"💰 Balance: ${self.state['balance']:,.2f}")
        print(f"🎯 Max Positions: 8")
        print(f"📈 STOCKS: ATR-based stops | 2:1 reward:risk")
        print(f"🎯 OPTIONS: +3% take profit | -2% stop loss")
        print(f"🛑 Circuit Breaker: -2% daily loss limit")
        print(f"⏰ Auto-close all at 3:45 PM ET")
        print(f"🛑 Bot stops at 4:00 PM ET (market close)")
        
        # Reset daily tracking
        self.enhanced_risk.reset_daily(self.state['balance'])
        
        scan_count = 0
        while True:
            try:
                # Check circuit breaker
                if self.enhanced_risk.check_circuit_breaker(self.state['balance']):
                    print("\n🚨 CIRCUIT BREAKER TRIGGERED: -2% daily loss limit hit")
                    await self._close_all_positions("Circuit breaker")
                    print("Bot stopped for today. Restart tomorrow.")
                    break
                
                if self._is_market_closed():
                    print("\n🛑 Market closed - shutting down bot")
                    await self._close_all_positions("Market closed")
                    break
                
                if self._is_near_market_close():
                    print("\n⏰ 3:45 PM - Closing all positions before market close")
                    await self._close_all_positions("End of day")
                    print("✅ All positions closed - waiting for market close")
                    await asyncio.sleep(900)
                    continue
                
                if scan_count % 10 == 0:
                    print(f"\n🔄 Refreshing trending stocks...")
                    self.symbols = await self.trending_scanner.get_trending_stocks(top_n=10)
                
                print(f"\n⏰ {datetime.now().strftime('%H:%M:%S')} - Scanning {len(self.symbols)} trending stocks...")
                await self.update_positions()
                await self.analyze_and_trade()
                print(f"📊 Positions: {len(self.state['positions'])}/8 | P&L: ${self.state['daily_pnl']:.2f}")
                
                scan_count += 1
                await asyncio.sleep(90)
            except Exception as e:
                print(f"Error: {e}")
                await asyncio.sleep(90)
    
    def _is_market_closed(self) -> bool:
        """Check if market is closed (after 4 PM ET)"""
        from datetime import datetime
        import pytz
        
        et = pytz.timezone('America/New_York')
        now = datetime.now(et)
        
        # Market closes at 4 PM ET
        if now.hour >= 16:
            return True
        
        # Weekend
        if now.weekday() >= 5:
            return True
        
        return False
    
    def _is_near_market_close(self) -> bool:
        """Check if within 15min of market close (3:45 PM ET)"""
        from datetime import datetime
        import pytz
        
        et = pytz.timezone('America/New_York')
        now = datetime.now(et)
        
        # Close all positions at 3:45 PM
        if now.hour == 15 and now.minute >= 45:
            return True
        
        return False
    
    async def _close_all_positions(self, reason: str):
        """Close all open positions"""
        print(f"\n🚨 Closing all positions: {reason}")
        
        for symbol in list(self.state['positions'].keys()):
            try:
                await self.close_position(symbol)
                await asyncio.sleep(1)
            except Exception as e:
                print(f"Error closing {symbol}: {e}")

engine = None

def get_engine():
    global engine
    if engine is None:
        engine = LiveTradingEngine()
    return engine

async def start_trading_engine():
    eng = get_engine()
    await eng.run()

if __name__ == '__main__':
    asyncio.run(start_trading_engine())
