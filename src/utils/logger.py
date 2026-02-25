"""
Logging utility for the trading bot.
Sets up structured logging with file rotation.
"""

import logging
import os
from datetime import datetime
from logging.handlers import RotatingFileHandler
from src.config import settings


def setup_logger(name: str = "trading_bot") -> logging.Logger:
    """
    Set up and return a configured logger instance.
    
    Args:
        name: Logger name
        
    Returns:
        Configured logger instance
    """
    logger = logging.getLogger(name)
    logger.setLevel(settings.log_level)

    # Create logs directory if it doesn't exist
    log_dir = os.path.dirname(settings.log_file_path)
    if log_dir and not os.path.exists(log_dir):
        os.makedirs(log_dir, exist_ok=True)

    # File handler with rotation (max 10MB, keep 3 backups)
    file_handler = RotatingFileHandler(
        settings.log_file_path,
        maxBytes=10*1024*1024,  # 10MB
        backupCount=3
    )
    file_handler.setLevel(settings.log_level)

    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(settings.log_level)

    # Formatter
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    file_handler.setFormatter(formatter)
    console_handler.setFormatter(formatter)

    # Add handlers
    if not logger.handlers:
        logger.addHandler(file_handler)
        logger.addHandler(console_handler)

    return logger


# Create global logger instance
logger = setup_logger()


def log_trade(trade_data: dict):
    """Log trade execution with structured data."""
    logger.info(
        f"TRADE: {trade_data.get('action')} {trade_data.get('symbol')} "
        f"@ {trade_data.get('price')} | SL: {trade_data.get('stop_loss')} | "
        f"Target: {trade_data.get('target_price')}"
    )
