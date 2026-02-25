"""
Initialize trading bot package.
"""

__version__ = "1.0.0"
__author__ = "Trading Bot Team"
__description__ = "Automated trading bot for Discord to Schwab integration"

from src.config import settings
from src.trading_engine import TradeExecutor
from src.discord_client import start_discord_bot

__all__ = [
    "settings",
    "TradeExecutor",
    "start_discord_bot"
]
