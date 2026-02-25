"""
Configuration management for the trading bot.
Handles environment variables and settings.
"""

import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings

# Load environment variables from .env file
load_dotenv()


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Discord Configuration
    discord_token: str = os.getenv("DISCORD_TOKEN", "")
    discord_channel_id: int = int(os.getenv("DISCORD_CHANNEL_ID", "0"))

    # IBKR Configuration
    IBKR_HOST: str = os.getenv("IBKR_HOST", "127.0.0.1")
    IBKR_PORT: int = int(os.getenv("IBKR_PORT", "7497"))  # 7497=paper, 7496=live
    IBKR_CLIENT_ID: int = int(os.getenv("IBKR_CLIENT_ID", "1"))

    # Schwab API Configuration (deprecated - using IBKR)
    schwab_client_id: str = os.getenv("SCHWAB_CLIENT_ID", "")
    schwab_client_secret: str = os.getenv("SCHWAB_CLIENT_SECRET", "")
    schwab_redirect_uri: str = os.getenv("SCHWAB_REDIRECT_URI", "http://localhost:8000/callback")
    schwab_account_id: str = os.getenv("SCHWAB_ACCOUNT_ID", "")
    schwab_auth_code: str = os.getenv("SCHWAB_AUTH_CODE", "")

    # Polymarket API Configuration
    polymarket_api_key: str = os.getenv("POLYMARKET_API_KEY", "")
    polymarket_private_key: str = os.getenv("POLYMARKET_PRIVATE_KEY", "")

    # Trading Configuration
    paper_trading: bool = os.getenv("PAPER_TRADING", "true").lower() == "true"
    enable_paper_money: bool = os.getenv("ENABLE_PAPER_MONEY", "true").lower() == "true"

    # Risk Management Settings
    stop_loss_percent: float = float(os.getenv("STOP_LOSS_PERCENT", "3"))
    trailing_stop_percent: float = float(os.getenv("TRAILING_STOP_PERCENT", "15"))
    max_position_size_percent: float = float(os.getenv("MAX_POSITION_SIZE_PERCENT", "80"))
    min_concurrent_trades: int = int(os.getenv("MIN_CONCURRENT_TRADES", "2"))
    max_concurrent_trades: int = int(os.getenv("MAX_CONCURRENT_TRADES", "5"))
    
    # Daily Return Strategy
    daily_return_target_min: float = float(os.getenv("DAILY_RETURN_TARGET_MIN", "0.20"))  # 20%
    daily_return_target_max: float = float(os.getenv("DAILY_RETURN_TARGET_MAX", "0.30"))  # 30%
    auto_exit_at_target: bool = os.getenv("AUTO_EXIT_AT_TARGET", "true").lower() == "true"

    # Channel Priority (Discord first, OpenClaw backup)
    discord_priority: bool = os.getenv("DISCORD_PRIORITY", "true").lower() == "true"
    openclaw_scan_interval: int = int(os.getenv("OPENCLAW_SCAN_INTERVAL", "30"))  # seconds
    
    # Logging Configuration
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    log_file_path: str = os.getenv("LOG_FILE_PATH", "./logs/trading_bot.log")
    
    # Options Trading Configuration
    options_enabled: bool = os.getenv("OPTIONS_ENABLED", "false").lower() == "true"
    alloc_split_mode: str = os.getenv("ALLOC_SPLIT_MODE", "dynamic")
    stock_alloc_pct: float = float(os.getenv("STOCK_ALLOC_PCT", "70"))
    options_alloc_pct: float = float(os.getenv("OPTIONS_ALLOC_PCT", "30"))
    random_select: bool = os.getenv("RANDOM_SELECT", "true").lower() == "true"
    options_max_positions: int = int(os.getenv("OPTIONS_MAX_POSITIONS", "3"))
    options_spread_width_pct: float = float(os.getenv("OPTIONS_SPREAD_WIDTH_PCT", "7.5"))
    options_min_iv: float = float(os.getenv("OPTIONS_MIN_IV", "30"))
    options_max_debit_pct: float = float(os.getenv("OPTIONS_MAX_DEBIT_PCT", "5"))
    options_take_profit_pct: float = float(os.getenv("OPTIONS_TAKE_PROFIT_PCT", "75"))
    options_stop_loss_pct: float = float(os.getenv("OPTIONS_STOP_LOSS_PCT", "50"))

    class Config:
        env_file = ".env"
        case_sensitive = False


# Global settings instance
settings = Settings()
