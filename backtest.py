"""
Backtesting module to validate trading strategy on historical data.
Tests OpenClaw + Polymarket dual validation approach.
"""
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List


class Backtester:
    """Backtest trading strategy on historical data."""
    
    def __init__(self, initial_capital: float = 100000):
        self.initial_capital = initial_capital
        self.capital = initial_capital
        self.positions = {}
        self.trades = []
        self.daily_returns = []
        
    def calculate_atr(self, df: pd.DataFrame, period: int = 14) -> pd.Series:
        """Calculate Average True Range."""
        high = df['High']
        low = df['Low']
        close = df['Close']
        
        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())
        
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        atr = tr.rolling(window=period).mean()
        
        return atr
    
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """Generate buy/sell signals based on strategy."""
        # Calculate indicators
        df['SMA_5'] = df['Close'].rolling(window=5).mean()
        df['SMA_20'] = df['Close'].rolling(window=20).mean()
        df['ATR'] = self.calculate_atr(df)
        df['Volume_Avg'] = df['Volume'].rolling(window=20).mean()
        
        # Trend score (simplified OpenClaw logic)
        df['Trend_Score'] = 0.0
        df.loc[df['Close'] > df['SMA_5'], 'Trend_Score'] += 0.3
        df.loc[df['SMA_5'] > df['SMA_20'], 'Trend_Score'] += 0.3
        df.loc[df['Volume'] > df['Volume_Avg'] * 1.5, 'Trend_Score'] += 0.2
        
        # Simulate Polymarket sentiment (random for backtest)
        np.random.seed(42)
        df['Poly_Score'] = np.random.uniform(0.4, 0.7, len(df))
        
        # Combined confidence
        df['Combined_Confidence'] = (df['Trend_Score'] * 0.6) + (df['Poly_Score'] * 0.4)
        
        # Generate signals
        df['Signal'] = 0
        df.loc[(df['Trend_Score'] > 0.55) & (df['Poly_Score'] > 0.55) & (df['Combined_Confidence'] > 0.60), 'Signal'] = 1
        
        return df
    
    def backtest_symbol(self, symbol: str, start_date: str, end_date: str) -> Dict:
        """Backtest single symbol."""
        try:
            # Download data
            df = yf.download(symbol, start=start_date, end=end_date, progress=False)
            
            if df.empty or len(df) < 30:
                return None
            
            # Generate signals
            df = self.generate_signals(df)
            
            # Simulate trading
            position = None
            trades_count = 0
            wins = 0
            
            for i in range(30, len(df)):
                current_price = df['Close'].iloc[i]
                atr = df['ATR'].iloc[i]
                
                # Entry logic
                if position is None and df['Signal'].iloc[i] == 1:
                    # Calculate position size (1% rule)
                    stop_distance = 2 * atr
                    risk_amount = self.capital * 0.01
                    shares = int(risk_amount / stop_distance) if stop_distance > 0 else 0
                    
                    if shares > 0:
                        position = {
                            'entry_price': current_price,
                            'shares': shares,
                            'stop_loss': current_price - stop_distance,
                            'take_profit': current_price + (stop_distance * 2),  # 2:1 ratio
                            'entry_date': df.index[i]
                        }
                        trades_count += 1
                
                # Exit logic
                elif position is not None:
                    exit_trade = False
                    exit_reason = ""
                    
                    # Stop loss
                    if current_price <= position['stop_loss']:
                        exit_trade = True
                        exit_reason = "Stop Loss"
                    
                    # Take profit
                    elif current_price >= position['take_profit']:
                        exit_trade = True
                        exit_reason = "Take Profit"
                        wins += 1
                    
                    # Time-based exit (5 days max)
                    elif (df.index[i] - position['entry_date']).days >= 5:
                        exit_trade = True
                        exit_reason = "Time Exit"
                        if current_price > position['entry_price']:
                            wins += 1
                    
                    if exit_trade:
                        pnl = (current_price - position['entry_price']) * position['shares']
                        self.capital += pnl
                        
                        self.trades.append({
                            'symbol': symbol,
                            'entry': position['entry_price'],
                            'exit': current_price,
                            'shares': position['shares'],
                            'pnl': pnl,
                            'reason': exit_reason
                        })
                        
                        position = None
            
            win_rate = (wins / trades_count * 100) if trades_count > 0 else 0
            
            return {
                'symbol': symbol,
                'trades': trades_count,
                'wins': wins,
                'win_rate': win_rate
            }
            
        except Exception as e:
            print(f"Error backtesting {symbol}: {e}")
            return None
    
    def run_backtest(self, symbols: List[str], start_date: str, end_date: str) -> Dict:
        """Run backtest with Sharpe ratio calculation."""
        print(f"\n🔬 Backtesting {len(symbols)} symbols from {start_date} to {end_date}")
        print(f"💰 Initial Capital: ${self.initial_capital:,.2f}\n")
        
        results = []
        daily_returns = []
        
        for symbol in symbols:
            print(f"Testing {symbol}...", end=" ")
            result = self.backtest_symbol(symbol, start_date, end_date)
            if result:
                results.append(result)
                print(f"✓ {result['trades']} trades, {result['win_rate']:.1f}% win rate")
            else:
                print("✗ Failed")
        
        total_trades = sum(r['trades'] for r in results)
        total_wins = sum(r['wins'] for r in results)
        overall_win_rate = (total_wins / total_trades * 100) if total_trades > 0 else 0
        
        total_pnl = sum(t['pnl'] for t in self.trades)
        final_capital = self.capital
        total_return = ((final_capital - self.initial_capital) / self.initial_capital) * 100
        
        winning_trades = [t['pnl'] for t in self.trades if t['pnl'] > 0]
        losing_trades = [abs(t['pnl']) for t in self.trades if t['pnl'] < 0]
        
        total_wins_amount = sum(winning_trades) if winning_trades else 0
        total_losses_amount = sum(losing_trades) if losing_trades else 1
        profit_factor = total_wins_amount / total_losses_amount if total_losses_amount > 0 else 0
        
        # Calculate Sharpe ratio
        if self.trades:
            returns = [t['pnl'] / self.initial_capital for t in self.trades]
            avg_return = np.mean(returns)
            std_return = np.std(returns)
            sharpe_ratio = (avg_return / std_return * np.sqrt(252)) if std_return > 0 else 0
        else:
            sharpe_ratio = 0
        
        print(f"\n{'='*60}")
        print(f"📊 BACKTEST RESULTS")
        print(f"{'='*60}")
        print(f"Total Trades: {total_trades}")
        print(f"Wins: {total_wins} | Losses: {total_trades - total_wins}")
        print(f"Win Rate: {overall_win_rate:.1f}%")
        print(f"Profit Factor: {profit_factor:.2f}")
        print(f"Sharpe Ratio: {sharpe_ratio:.2f} {'✅' if sharpe_ratio > 1.0 else '⚠️'}")
        print(f"\nInitial Capital: ${self.initial_capital:,.2f}")
        print(f"Final Capital: ${final_capital:,.2f}")
        print(f"Total Return: {total_return:+.2f}%")
        print(f"Total P&L: ${total_pnl:+,.2f}")
        print(f"{'='*60}\n")
        
        return {
            'total_trades': total_trades,
            'win_rate': overall_win_rate,
            'profit_factor': profit_factor,
            'sharpe_ratio': sharpe_ratio,
            'total_return': total_return,
            'final_capital': final_capital
        }


def run_quick_backtest():
    """Run a quick backtest on recent data."""
    # Test on last 6 months
    end_date = datetime.now()
    start_date = end_date - timedelta(days=180)
    
    symbols = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMD', 'META', 'GOOGL', 'AMZN', 'SPY', 'QQQ']
    
    backtester = Backtester(initial_capital=100000)
    results = backtester.run_backtest(
        symbols=symbols,
        start_date=start_date.strftime('%Y-%m-%d'),
        end_date=end_date.strftime('%Y-%m-%d')
    )
    
    # Recommendations
    print("💡 RECOMMENDATIONS:")
    if results['win_rate'] < 50:
        print("⚠️  Win rate below 50% - adjust thresholds higher (try 65% combined)")
    else:
        print("✅ Win rate acceptable")
    
    if results['profit_factor'] < 1.5:
        print("⚠️  Profit factor low - tighten stops or widen targets")
    else:
        print("✅ Profit factor good")
    
    if results['total_return'] < 5:
        print("⚠️  Returns low for 6 months - increase position sizing or trade frequency")
    else:
        print("✅ Returns acceptable")


if __name__ == '__main__':
    run_quick_backtest()
