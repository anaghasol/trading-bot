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
    """Get positions from state file + guru trades"""
    state = load_state()
    positions = []
    
    # Add regular positions
    for symbol, pos in state['positions'].items():
        positions.append({
            'symbol': pos.get('option_symbol', symbol),
            'quantity': pos.get('quantity', 0),
            'entry_price': pos.get('entry_price', 0),
            'current_price': pos.get('current_price', 0),
            'pnl': pos.get('pnl', 0),
            'pnl_pct': pos.get('pnl_pct', 0),
            'type': pos.get('type', 'STOCK'),
            'source': 'BOT'
        })
    
    # Add guru positions
    guru_file = Path('guru_trades.json')
    if guru_file.exists():
        with open(guru_file, 'r') as f:
            guru_data = json.load(f)
            for pos in guru_data.get('positions', []):
                if pos.get('status') == 'OPEN':
                    positions.append({
                        'symbol': f"{pos['symbol']} {pos['expiration']} ${pos['strike']}{pos['type'][0]}",
                        'quantity': pos.get('contracts', 0),
                        'entry_price': pos.get('entry_price', 0),
                        'current_price': pos.get('entry_price', 0),  # TODO: Get live price
                        'pnl': 0,  # TODO: Calculate from current price
                        'pnl_pct': 0,
                        'type': 'OPTION',
                        'source': 'GURU'
                    })
    
    return jsonify({
        'positions': positions,
        'count': len(positions),
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/trades')
def get_trades():
    """Get ALL today's trades with P&L breakdown + guru trades"""
    state = load_state()
    from datetime import datetime
    
    # Filter today's trades only
    today = datetime.now().strftime('%Y-%m-%d')
    today_trades = [
        t for t in state['trades']
        if t.get('timestamp', '').startswith(today)
    ]
    
    # Add guru trades
    guru_file = Path('guru_trades.json')
    if guru_file.exists():
        with open(guru_file, 'r') as f:
            guru_data = json.load(f)
            for pos in guru_data.get('positions', []):
                if pos.get('timestamp', '').startswith(today):
                    today_trades.append({
                        'symbol': f"{pos['symbol']} {pos['expiration']} ${pos['strike']}{pos['type'][0]}",
                        'action': 'BUY',
                        'quantity': pos.get('contracts', 0),
                        'price': pos.get('entry_price', 0),
                        'timestamp': pos.get('timestamp', ''),
                        'status': pos.get('status', 'OPEN'),
                        'confidence': 95,  # Guru trade
                        'type': 'OPTION',
                        'source': 'GURU'
                    })
    
    # Sort by timestamp (newest first)
    today_trades.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    
    # Calculate P&L breakdown
    closed_trades = [t for t in today_trades if t.get('status') == 'CLOSED']
    open_trades = [t for t in today_trades if t.get('status') == 'OPEN']
    
    closed_pnl = sum(t.get('pnl', 0) for t in closed_trades)
    open_pnl = sum(state['positions'].get(t['symbol'], {}).get('pnl', 0) for t in open_trades if t.get('source') != 'GURU')
    
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

@app.route('/api/guru-trade', methods=['POST'])
def guru_trade():
    """Execute guru trade LIVE in IBKR"""
    import re
    import asyncio
    from src.ibkr_client import IBKRClient
    from src.config import settings
    
    data = request.get_json()
    alert = data.get('alert', '')
    
    # Parse alert
    symbol_match = re.search(r'TRADE:\s*([A-Z]{1,5})', alert)
    if not symbol_match:
        return jsonify({'error': 'Could not find symbol'}), 400
    
    symbol = symbol_match.group(1)
    
    # Parse strategy
    is_call = 'CALL' in alert.upper()
    is_put = 'PUT' in alert.upper()
    right = 'C' if is_call else 'P'
    
    # Parse strike/expiration (e.g., "4/17 $220c")
    strike_match = re.search(r'(\d+)/(\d+)\s*\$?(\d+\.?\d*)([cp])', alert, re.IGNORECASE)
    if not strike_match:
        return jsonify({'error': 'Could not parse strike/expiration'}), 400
    
    month = int(strike_match.group(1))
    day = int(strike_match.group(2))
    strike = float(strike_match.group(3))
    
    # Build expiration string (YYYYMMDD)
    from datetime import datetime
    year = datetime.now().year
    if month < datetime.now().month:
        year += 1
    expiration = f"{year}{month:02d}{day:02d}"
    
    # Parse price
    price_match = re.search(r'\$(\d+\.\d+)', alert)
    price = float(price_match.group(1)) if price_match else 0
    
    # Get current balance and calculate position size
    state = load_state()
    balance = state.get('balance', 1000000.0)
    
    # 50/50 allocation: Use 50% of balance for options
    options_allocation = balance * 0.50
    
    # Calculate contracts: divide allocation by option cost
    option_cost = price * 100  # Each contract = 100 shares
    contracts = max(1, int(options_allocation / option_cost / 10))  # Divide by 10 for safety
    
    # Execute in IBKR
    async def execute_option():
        client = IBKRClient(
            host=settings.IBKR_HOST,
            port=settings.IBKR_PORT,
            client_id=settings.IBKR_CLIENT_ID + 200
        )
        await client.connect()
        
        # Place options order
        order = await client.place_options_order(
            symbol=symbol,
            expiration=expiration,
            strike=strike,
            right=right,
            quantity=contracts,
            action='BUY',
            order_type='MKT'
        )
        
        client.disconnect()
        return order
    
    try:
        order = asyncio.run(execute_option())
        
        if not order:
            return jsonify({'error': 'IBKR order failed'}), 500
        
        # Save to guru_trades.json
        guru_file = Path('guru_trades.json')
        guru_data = {'positions': []}
        if guru_file.exists():
            with open(guru_file, 'r') as f:
                guru_data = json.load(f)
        
        guru_data['positions'].append({
            'symbol': symbol,
            'type': 'CALL' if is_call else 'PUT',
            'strike': strike,
            'expiration': expiration,
            'contracts': contracts,
            'entry_price': price,
            'timestamp': datetime.now().isoformat(),
            'status': 'OPEN',
            'alert': alert,
            'ibkr_order_id': order.get('orderId') if order else None
        })
        
        with open(guru_file, 'w') as f:
            json.dump(guru_data, f, indent=2)
        
        return jsonify({
            'success': True, 
            'symbol': symbol, 
            'price': price,
            'contracts': contracts,
            'message': f'Executed {contracts} contracts in IBKR'
        })
    except Exception as e:
        return jsonify({'error': f'Execution failed: {str(e)}'}), 500

@app.route('/api/guru-positions')
def guru_positions():
    """Get guru positions"""
    guru_file = Path('guru_trades.json')
    if guru_file.exists():
        with open(guru_file, 'r') as f:
            data = json.load(f)
            return jsonify(data)
    return jsonify({'positions': []})

@app.route('/api/close-guru', methods=['POST'])
def close_guru():
    """Close guru position in IBKR"""
    import asyncio
    from src.ibkr_client import IBKRClient
    from src.config import settings
    
    data = request.get_json()
    symbol = data.get('symbol')
    
    guru_file = Path('guru_trades.json')
    if not guru_file.exists():
        return jsonify({'error': 'No guru trades found'}), 404
    
    with open(guru_file, 'r') as f:
        guru_data = json.load(f)
    
    position = None
    for pos in guru_data['positions']:
        if pos['symbol'] == symbol and pos['status'] == 'OPEN':
            position = pos
            break
    
    if not position:
        return jsonify({'error': 'Position not found'}), 404
    
    # Close in IBKR
    async def close_option():
        client = IBKRClient(
            host=settings.IBKR_HOST,
            port=settings.IBKR_PORT,
            client_id=settings.IBKR_CLIENT_ID + 201
        )
        await client.connect()
        
        # Place SELL order to close
        order = await client.place_options_order(
            symbol=position['symbol'],
            expiration=position['expiration'],
            strike=position['strike'],
            right='C' if position['type'] == 'CALL' else 'P',
            quantity=position['contracts'],
            action='SELL',
            order_type='MKT'
        )
        
        client.disconnect()
        return order
    
    try:
        order = asyncio.run(close_option())
        
        # Update status
        position['status'] = 'CLOSED'
        position['close_time'] = datetime.now().isoformat()
        
        with open(guru_file, 'w') as f:
            json.dump(guru_data, f, indent=2)
        
        return jsonify({'success': True, 'message': f'Closed {symbol} in IBKR'})
    except Exception as e:
        return jsonify({'error': f'Close failed: {str(e)}'}), 500

def start_dashboard(port=8080):
    from threading import Thread
    def run():
        app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
    thread = Thread(target=run, daemon=True)
    thread.start()
    return thread

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=True)
