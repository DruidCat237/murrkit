"""
Logger setup for murrkit.

loguru is configured in core/config.py at import time (singleton pattern).
This module re-exports the logger for convenient import:

    from core.logger import logger

    logger.info("Starting pipeline...")
    logger.debug("Frame count: {n}", n=4)
"""

from loguru import logger

__all__ = ["logger"]
