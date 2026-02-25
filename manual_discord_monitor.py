#!/usr/bin/env python3
"""
Manual Discord Monitor - Check guru channels and execute trades
Run this when you see a trade alert in Discord
"""
import asyncio
from src.ibkr_client import IBKRClient
from src.config import settings
import json
from datetime import datetime

class ManualTradeExecutor:
    def __init__(self):
        self.ibkr = IBKRClient(
            host=settings.IBKR_HOST,
            port=settings.IBKR_PORT,
            client_id=settings.IBKR_CLIENT_ID
        )
        self.state_file = 'trading_state.json'
    
    def load_state(self):
        try:
            with open(self.state_file, 'r') as f:
                return json.load(f)
        except:
            return {'positions': {}, 'trades': [], 'balance': 1000000.0}
    
    def save_state(self, state):
        with open(self.state_file, 'w') as f:
            json.dump(state, f, indent=2)
    
    async def execute_guru_trade(self, symbol: str, action: str, notes: str = ""):
        """Execute trade from guru recommendation"""
        state = self.load_state()
        
        # Position size: 10% of balance
        position_value = state['balance'] * 0.10
        
        # Get current price
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period='1d')
        
        if hist.empty:
            print(f"❌ Cannot get price for {symbol}")
            return
        
        price = float(hist['Close'].iloc[-1])
        quantity = int(position_value / price)
        
        if quantity < 1:
            print(f"❌ Quantity too small for {symbol}")
            return
        
        print(f"\n🎯 GURU TRADE: {action} {quantity} {symbol} @ ${price:.2f}")
        print(f"📝 Notes: {notes}")
        
        confirm = input("Execute this trade? (yes/no): ")
        
        if confirm.lower() != 'yes':
            print("❌ Trade cancelled")
            return
        
        # Connect and execute
        if not self.ibkr.connected:
            await self.ibkr.connect()
        
        order = await self.ibkr.place_stock_order(
            symbol=symbol,
            quantity=quantity,
            action=action.upper(),
            order_type='MKT'
        )
        
        if order:
            # Log trade
            trade = {
                'symbol': symbol,
                'action': action.upper(),
                'quantity': quantity,
                'price': price,
                'confidence': 90,  # Guru trade
                'timestamp': datetime.now().isoformat(),
                'status': 'OPEN',
                'source': 'GURU',
                'notes': notes
            }
            
            state['trades'].append(trade)
            state['positions'][symbol] = {
                'quantity': quantity if action.upper() == 'BUY' else -quantity,
                'entry_price': price,
                'current_price': price,
                'pnl': 0.0,
                'pnl_pct': 0.0,
                'source': 'GURU'
            }
            
            self.save_state(state)
            print(f"✅ EXECUTED: {action} {quantity} {symbol} @ ${price:.2f}")
        else:
            print("❌ Order failed")

async def main():
    """Interactive menu for manual trade execution"""
    executor = ManualTradeExecutor()
    
    print("=" * 60)
    print("🎯 MANUAL DISCORD TRADE EXECUTOR")
    print("=" * 60)
    print("\nWhen you see a trade alert from HatTrick or cmgventure:")
    print("1. Note the symbol and action (BUY/SELL)")
    print("2. Run this script")
    print("3. Enter the details below\n")
    
    symbol = input("Symbol (e.g., AAPL): ").strip().upper()
    action = input("Action (BUY/SELL): ").strip().upper()
    notes = input("Notes (optional): ").strip()
    
    if symbol and action in ['BUY', 'SELL']:
        await executor.execute_guru_trade(symbol, action, notes)
    else:
        print("❌ Invalid input")

if __name__ == '__main__':
    asyncio.run(main())
