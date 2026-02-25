"""
Trading Dashboard - Simplified with caching
"""
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from datetime import datetime
import json
from pathlib import Path
import time

app = Flask(__name__)
CORS(app)

STATE_FILE = Path('trading_state.json')
hot_stocks_cache = {'data': [], 'time': 0}

def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    return {
        'positions': {},
        'trades': [],
        'balance': 1000000.0,
        'daily_pnl': 0.0
    }

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/balance')
def get_balance():
    """Get balance with detailed breakdown"""
    try:
        from src.ibkr_client import IBKRClient
        from src.config import settings
        import asyncio
        
        # Get fresh balance from IBKR
        async def get_ibkr_balance():
            client = IBKRClient(
                host=settings.IBKR_HOST,
                port=settings.IBKR_PORT,
                client_id=settings.IBKR_CLIENT_ID + 100
            )
            await client.connect()
            balance = await client.get_account_balance()
            client.disconnect()
            return balance
        
        current_balance = asyncio.run(get_ibkr_balance())
        state = load_state()
        
        if current_balance:
            starting = state.get('starting_balance', 1000000.0)
            pnl = current_balance - starting
            
            # Calculate P&L from visible trades
            closed_trades = [t for t in state['trades'] if t.get('status') == 'CLOSED']
            visible_closed_pnl = sum(t.get('pnl', 0) for t in closed_trades)
            
            open_positions_pnl = sum(p.get('pnl', 0) for p in state['positions'].values())
            
            visible_total_pnl = visible_closed_pnl + open_positions_pnl
            missing_pnl = pnl - visible_total_pnl
            
            return jsonify({
                'balance': starting,
                'current_balance': current_balance,
                'daily_pnl': pnl,
                'visible_pnl': visible_total_pnl,
                'missing_pnl': missing_pnl,
                'closed_trades_count': len(closed_trades),
                'timestamp': datetime.now().isoformat()
            })
    except Exception as e:
        print(f"Error getting IBKR balance: {e}")
    
    # Fallback
    state = load_state()
    return jsonify({
        'balance': state.get('starting_balance', 1000000.0),
        'current_balance': state.get('balance', 1000000.0),
        'daily_pnl': state.get('daily_pnl', 0),
        'visible_pnl': 0,
        'missing_pnl': 0,
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/positions')
def get_positions():
    """Get positions from state file (synced with IBKR)"""
    state = load_state()
    positions = []
    
    for symbol, pos in state['positions'].items():
        positions.append({
            'symbol': pos.get('option_symbol', symbol),
            'quantity': pos.get('quantity', 0),
            'entry_price': pos.get('entry_price', 0),
            'current_price': pos.get('current_price', 0),
            'pnl': pos.get('pnl', 0),
            'pnl_pct': pos.get('pnl_pct', 0),
            'type': pos.get('type', 'STOCK')
        })
    
    return jsonify({
        'positions': positions,
        'count': len(positions),
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/trades')
def get_trades():
    """Get ALL today's trades with P&L breakdown"""
    state = load_state()
    from datetime import datetime
    
    # Filter today's trades only
    today = datetime.now().strftime('%Y-%m-%d')
    today_trades = [
        t for t in state['trades']
        if t.get('timestamp', '').startswith(today)
    ]
    
    # Sort by timestamp (newest first)
    today_trades.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    
    # Calculate P&L breakdown
    closed_trades = [t for t in today_trades if t.get('status') == 'CLOSED']
    open_trades = [t for t in today_trades if t.get('status') == 'OPEN']
    
    closed_pnl = sum(t.get('pnl', 0) for t in closed_trades)
    open_pnl = sum(state['positions'].get(t['symbol'], {}).get('pnl', 0) for t in open_trades)
    
    return jsonify({
        'trades': today_trades,
        'count': len(today_trades),
        'closed_count': len(closed_trades),
        'open_count': len(open_trades),
        'closed_pnl': closed_pnl,
        'open_pnl': open_pnl,
        'total_pnl': state.get('daily_pnl', 0),
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/hot-stocks')
def get_hot_stocks():
    """Cached hot stocks - updates every 3 minutes"""
    global hot_stocks_cache
    now = time.time()
    
    # Return cached data if less than 3 minutes old
    if now - hot_stocks_cache['time'] < 180 and hot_stocks_cache['data']:
        return jsonify({
            'stocks': hot_stocks_cache['data'],
            'timestamp': datetime.now().isoformat()
        })
    
    # Generate new data
    try:
        import yfinance as yf
        symbols = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD']
        hot_stocks = []
        
        for symbol in symbols:
            try:
                ticker = yf.Ticker(symbol)
                hist = ticker.history(period='5d')
                
                if len(hist) >= 2:
                    current_price = float(hist['Close'].iloc[-1])
                    prev_price = float(hist['Close'].iloc[-2])
                    change_pct = ((current_price - prev_price) / prev_price) * 100
                    confidence = min(90, 60 + abs(change_pct) * 10)
                    
                    hot_stocks.append({
                        'symbol': symbol,
                        'price': round(current_price, 2),
                        'change': round(change_pct, 2),
                        'confidence': round(confidence, 1),
                        'action': 'BUY' if change_pct > 0 else 'SELL'
                    })
                
                time.sleep(0.5)
            except:
                continue
        
        hot_stocks.sort(key=lambda x: x['confidence'], reverse=True)
        hot_stocks_cache = {'data': hot_stocks, 'time': now}
        
        return jsonify({
            'stocks': hot_stocks,
            'timestamp': datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({'stocks': hot_stocks_cache['data']})

def start_dashboard(port=8080):
    from threading import Thread
    def run():
        app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
    thread = Thread(target=run, daemon=True)
    thread.start()
    return thread

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=True)
