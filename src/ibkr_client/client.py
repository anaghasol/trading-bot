"""
Interactive Brokers API Client
Handles connection, authentication, and trade execution
"""
from ib_insync import IB, Stock, Option, MarketOrder, LimitOrder, util
import asyncio
from typing import Optional, Dict, List
from ..utils.logger import setup_logger

logger = setup_logger(__name__)


class IBKRClient:
    def __init__(self, host: str = '127.0.0.1', port: int = 7497, client_id: int = 1):
        """
        Initialize IBKR client
        
        Args:
            host: TWS/Gateway host (default: localhost)
            port: 7497 for paper trading, 7496 for live
            client_id: Unique client identifier
        """
        self.ib = IB()
        self.host = host
        self.port = port
        self.client_id = client_id
        self.connected = False
        
    async def connect(self):
        """Connect to TWS or IB Gateway"""
        try:
            await self.ib.connectAsync(self.host, self.port, clientId=self.client_id)
            self.connected = True
            logger.info(f"✅ Connected to IBKR on {self.host}:{self.port}")
            return True
        except Exception as e:
            logger.error(f"❌ IBKR connection failed: {e}")
            self.connected = False
            return False
    
    def disconnect(self):
        """Disconnect from IBKR"""
        if self.connected:
            self.ib.disconnect()
            self.connected = False
            logger.info("Disconnected from IBKR")
    
    async def get_account_balance(self) -> Optional[float]:
        """Get account balance"""
        try:
            account_values = self.ib.accountValues()
            for av in account_values:
                if av.tag == 'NetLiquidation' and av.currency == 'USD':
                    balance = float(av.value)
                    logger.info(f"💰 Account Balance: ${balance:,.2f}")
                    return balance
            return None
        except Exception as e:
            logger.error(f"Error getting balance: {e}")
            return None
    
    async def place_stock_order(self, symbol: str, quantity: int, action: str, order_type: str = 'MKT', limit_price: Optional[float] = None) -> Optional[Dict]:
        """
        Place stock order
        
        Args:
            symbol: Stock ticker
            quantity: Number of shares
            action: 'BUY' or 'SELL'
            order_type: 'MKT' or 'LMT'
            limit_price: Required for limit orders
        """
        try:
            contract = Stock(symbol, 'SMART', 'USD')
            await self.ib.qualifyContractsAsync(contract)
            
            if order_type == 'MKT':
                order = MarketOrder(action, quantity)
            else:
                if not limit_price:
                    raise ValueError("Limit price required for limit orders")
                order = LimitOrder(action, quantity, limit_price)
            
            trade = self.ib.placeOrder(contract, order)
            await asyncio.sleep(1)  # Wait for order to process
            
            logger.info(f"📈 {action} {quantity} {symbol} @ {order_type}")
            
            return {
                'symbol': symbol,
                'quantity': quantity,
                'action': action,
                'order_type': order_type,
                'status': trade.orderStatus.status,
                'order_id': trade.order.orderId
            }
        except Exception as e:
            logger.error(f"Error placing stock order: {e}")
            return None
    
    async def place_options_order(self, symbol: str, expiration: str, strike: float, 
                                  right: str, quantity: int, action: str, 
                                  order_type: str = 'MKT', limit_price: Optional[float] = None) -> Optional[Dict]:
        """
        Place options order
        
        Args:
            symbol: Underlying ticker
            expiration: Format: YYYYMMDD
            strike: Strike price
            right: 'C' for call, 'P' for put
            quantity: Number of contracts
            action: 'BUY' or 'SELL'
            order_type: 'MKT' or 'LMT'
            limit_price: Required for limit orders
        """
        try:
            contract = Option(symbol, expiration, strike, right, 'SMART')
            await self.ib.qualifyContractsAsync(contract)
            
            if order_type == 'MKT':
                order = MarketOrder(action, quantity)
            else:
                if not limit_price:
                    raise ValueError("Limit price required for limit orders")
                order = LimitOrder(action, quantity, limit_price)
            
            trade = self.ib.placeOrder(contract, order)
            await asyncio.sleep(1)
            
            logger.info(f"📊 {action} {quantity} {symbol} {expiration} {strike}{right} @ {order_type}")
            
            return {
                'symbol': symbol,
                'expiration': expiration,
                'strike': strike,
                'right': right,
                'quantity': quantity,
                'action': action,
                'order_type': order_type,
                'status': trade.orderStatus.status,
                'order_id': trade.order.orderId
            }
        except Exception as e:
            logger.error(f"Error placing options order: {e}")
            return None
    
    async def get_positions(self) -> List[Dict]:
        """Get current positions with real-time P&L"""
        try:
            positions = self.ib.positions()
            result = []
            for pos in positions:
                # Get contract details
                contract = pos.contract
                
                # Request market data for current price
                self.ib.reqMktData(contract, '', False, False)
                await asyncio.sleep(0.5)  # Wait for price update
                
                ticker = self.ib.ticker(contract)
                current_price = ticker.marketPrice() if ticker.marketPrice() else ticker.last
                
                # Calculate P&L
                avg_cost = pos.avgCost / pos.position if pos.position != 0 else 0
                market_value = pos.marketValue
                unrealized_pnl = pos.unrealizedPNL
                
                position_data = {
                    'symbol': contract.symbol,
                    'quantity': pos.position,
                    'avg_cost': avg_cost,
                    'current_price': current_price if current_price else 0,
                    'market_value': market_value,
                    'unrealized_pnl': unrealized_pnl,
                    'contract_type': 'OPTION' if hasattr(contract, 'strike') else 'STOCK'
                }
                
                # Add option details if it's an option
                if hasattr(contract, 'strike'):
                    position_data.update({
                        'strike': contract.strike,
                        'right': contract.right,
                        'expiration': contract.lastTradeDateOrContractMonth
                    })
                
                result.append(position_data)
            
            return result
        except Exception as e:
            logger.error(f"Error getting positions: {e}")
            return []
    
    async def cancel_order(self, order_id: int):
        """Cancel an order"""
        try:
            trade = [t for t in self.ib.trades() if t.order.orderId == order_id]
            if trade:
                self.ib.cancelOrder(trade[0].order)
                logger.info(f"❌ Cancelled order {order_id}")
                return True
            return False
        except Exception as e:
            logger.error(f"Error cancelling order: {e}")
            return False
