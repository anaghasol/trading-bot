"""
Trade execution engine.
Executes trades based on Discord alerts combined with Polymarket intelligence.
"""

import uuid
from datetime import datetime
from typing import Optional, Dict, Any
from src.utils import logger, log_trade
from src.config import settings
from src.ibkr_client import IBKRClient
from src.trading_engine.risk_manager import RiskManager
from src.intelligence import IntelligenceEngine


class TradeExecutor:
    """Executes trades with intelligence and risk management."""

    def __init__(self):
        self.ibkr_client = IBKRClient()
        self.risk_manager = RiskManager()
        self.intelligence = IntelligenceEngine()
        self.executed_trades = {}
        logger.info("TradeExecutor initialized with IBKR and Intelligence Engine")

    async def execute_trade(self, trade_data: Dict[str, Any]) -> bool:
        """
        Execute a trade based on Discord alert + Polymarket intelligence.
        
        Args:
            trade_data: Dictionary with trade information from Discord
            
        Returns:
            True if trade executed successfully, False otherwise
        """
        # Step 1: Validate trade data
        if not self._validate_trade_data(trade_data):
            logger.warning(f"Invalid trade data: {trade_data}")
            return False

        # Step 2: Analyze with Intelligence Engine (Discord + Polymarket)
        analyzed_trade = self.intelligence.analyze_trade_alert(trade_data)
        
        # Step 3: Check if analysis recommends execution
        if not self.intelligence.should_execute_trade(analyzed_trade):
            logger.warning(
                f"Trade skipped by intelligence: {analyzed_trade.get('symbol')} "
                f"(confidence: {analyzed_trade.get('combined_confidence', 0):.0%})"
            )
            return False

        # Step 4: Check concurrent trade limit
        active_trades = self.risk_manager.get_active_positions_count()
        max_trades = self.risk_manager.get_random_concurrent_trades()

        if active_trades >= max_trades:
            logger.warning(
                f"Max concurrent trades reached ({active_trades}/{max_trades}). "
                f"Skipping trade for {analyzed_trade.get('symbol')}"
            )
            return False

        # Step 5: Get account balance
        balance = await self.ibkr_client.get_account_balance()
        if not balance:
            logger.error("Failed to get account balance")
            return False
        balance_info = {"cash_balance": balance}

        trade_id = str(uuid.uuid4())
        trade_type = self._detect_trade_type(trade_data)

        # Step 6: Apply position multiplier from intelligence
        recommendation = analyzed_trade.get("recommendation", {})
        position_multiplier = recommendation.get("position_multiplier", 1.0)

        # Step 7: Execute based on trade type
        if trade_type == "OPTIONS":
            success = await self._execute_options_trade(
                trade_id, analyzed_trade, balance_info, position_multiplier
            )
        else:
            success = await self._execute_stock_trade(
                trade_id, analyzed_trade, balance_info, position_multiplier
            )

        if success:
            log_trade({
                "action": analyzed_trade.get("action"),
                "symbol": analyzed_trade.get("symbol"),
                "price": analyzed_trade.get("price"),
                "stop_loss": analyzed_trade.get("calculated_stop_loss"),
                "target_price": analyzed_trade.get("target_price"),
                "confidence": analyzed_trade.get("combined_confidence"),
                "recommendation": recommendation.get("action")
            })

        return success

    async def execute_discord_guru_trade(self, trade_data: Dict[str, Any]) -> bool:
        """
        Execute Discord GURU signal - MANDATORY EXECUTION.
        
        These are trusted community signals from experienced traders.
        Execute ALL of them without intelligence validation.
        Only check: basic validation, risk limits, position sizing.
        
        Args:
            trade_data: Dictionary with trade information from Discord guru
            
        Returns:
            True if trade executed successfully, False otherwise
        """
        # Step 1: Validate trade data structure
        if not self._validate_trade_data(trade_data):
            logger.warning(f"Invalid Discord guru trade data: {trade_data}")
            return False

        symbol = trade_data.get("symbol", "UNKNOWN")
        
        # Step 2: Check concurrent trade limit (ONLY risk check, no intelligence filtering)
        active_trades = self.risk_manager.get_active_positions_count()
        max_trades = self.risk_manager.get_random_concurrent_trades()

        if active_trades >= max_trades:
            logger.warning(
                f"Max concurrent trades reached ({active_trades}/{max_trades}). "
                f"Skipping guru trade for {symbol}"
            )
            return False

        # Step 3: Get account balance
        balance = await self.ibkr_client.get_account_balance()
        if not balance:
            logger.error("Failed to get account balance")
            return False
        balance_info = {"cash_balance": balance}

        trade_id = str(uuid.uuid4())
        trade_type = self._detect_trade_type(trade_data)

        # Step 4: Use higher position multiplier for guru signals
        # Guru signals are trusted = can size up more aggressively
        position_multiplier = 1.5  # 50% larger than normal OpenClaw signals

        # Step 5: Execute based on trade type
        logger.info(f"🎯 EXECUTING DISCORD GURU SIGNAL: {symbol} (mandatory execution)")
        
        if trade_type == "OPTIONS":
            success = await self._execute_options_trade(
                trade_id, trade_data, balance_info, position_multiplier
            )
        else:
            success = await self._execute_stock_trade(
                trade_id, trade_data, balance_info, position_multiplier
            )

        if success:
            log_trade({
                "action": trade_data.get("action"),
                "symbol": symbol,
                "price": trade_data.get("price"),
                "stop_loss": trade_data.get("stop_loss"),
                "target_price": trade_data.get("target_price"),
                "source": "DISCORD_GURU",
                "position_multiplier": position_multiplier
            })

        return success

    async def _execute_stock_trade(
        self,
        trade_id: str,
        trade_data: Dict[str, Any],
        balance_info: Dict[str, Any],
        position_multiplier: float = 1.0
    ) -> bool:
        """Execute a stock trade."""
        try:
            symbol = trade_data.get("symbol")
            action = trade_data.get("action")
            entry_price = trade_data.get("price", 0)

            # Calculate stop loss
            stop_loss = self.risk_manager.get_stop_loss_price(entry_price, action)
            trade_data["calculated_stop_loss"] = stop_loss

            # Calculate position size with multiplier from intelligence
            available_cash = balance_info.get("cash_balance", 0)
            base_position_size = self.risk_manager.calculate_position_size(
                available_cash, entry_price
            )
            position_size = int(base_position_size * position_multiplier)

            if position_size <= 0:
                logger.warning(f"Position size too small for {symbol}")
                return False

            # Place order
            order = await self.ibkr_client.place_stock_order(
                symbol=symbol,
                quantity=position_size,
                action=action,
                order_type='LMT' if entry_price > 0 else 'MKT',
                limit_price=entry_price if entry_price > 0 else None
            )

            if order:
                self.risk_manager.register_position(trade_id, {
                    **trade_data,
                    "order_id": order.get("order_id"),
                    "position_size": position_size,
                    "position_multiplier": position_multiplier,
                    "executed_at": datetime.now().isoformat()
                })
                logger.info(f"Stock trade executed: {symbol} {action} x{position_size} (multiplier: {position_multiplier})")
                return True
            else:
                logger.error(f"Failed to place stock order for {symbol}")
                return False

        except Exception as e:
            logger.error(f"Error executing stock trade: {e}")
            return False

    async def _execute_options_trade(
        self,
        trade_id: str,
        trade_data: Dict[str, Any],
        balance_info: Dict[str, Any],
        position_multiplier: float = 1.0
    ) -> bool:
        """Execute an options trade."""
        try:
            symbol = trade_data.get("symbol")
            action = trade_data.get("action")

            # For options, limit quantity to 1-5 contracts with multiplier
            base_quantity = min(5, max(1, int(balance_info.get("cash_balance", 1000) / 500)))
            quantity = max(1, int(base_quantity * position_multiplier))
            
            logger.info(
                f"Options trade: {symbol} {action} - "
                f"debit: {trade_data.get('debit_per_contract')}, "
                f"premium: {trade_data.get('premium_per_contract')}, "
                f"max_gain: {trade_data.get('max_gain_per_contract')}, "
                f"multiplier: {position_multiplier}"
            )

            # Note: Full options execution requires expiration date and strike parsing
            # For now, log the action
            self.risk_manager.register_position(trade_id, {
                **trade_data,
                "quantity": quantity,
                "position_multiplier": position_multiplier,
                "executed_at": datetime.now().isoformat()
            })

            logger.info(f"Options trade registered: {symbol} {action} x{quantity}")
            return True

        except Exception as e:
            logger.error(f"Error executing options trade: {e}")
            return False

    @staticmethod
    def _validate_trade_data(trade_data: Dict[str, Any]) -> bool:
        """Validate required fields in trade data."""
        required_fields = ["action", "symbol"]
        return all(field in trade_data for field in required_fields)

    @staticmethod
    def _detect_trade_type(trade_data: Dict[str, Any]) -> str:
        """Detect if trade is stock or options based on action."""
        action = trade_data.get("action", "").upper()
        if action in ["BTO", "STO", "BTC", "STC"]:
            return "OPTIONS"
        return "STOCK"

    async def close_trade(self, trade_id: str) -> bool:
        """Close a trade position."""
        try:
            position = self.risk_manager.active_positions.get(trade_id)
            if not position:
                return False

            symbol = position.get("symbol")
            order_id = position.get("order_id")

            if order_id:
                await self.ibkr_client.cancel_order(order_id)

            self.risk_manager.close_position(trade_id)
            logger.info(f"Trade closed: {symbol}")
            return True

        except Exception as e:
            logger.error(f"Error closing trade: {e}")
            return False

    def get_active_trades(self) -> Dict[str, Any]:
        """Get all active trades."""
        return {
            trade_id: position
            for trade_id, position in self.risk_manager.active_positions.items()
            if position.get("status") == "OPEN"
        }
