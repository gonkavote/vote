"""Entrypoint: `python -m backend.notifier`.

Run as a separate Docker service (gonka-vote-notifier). Polls the
notification_jobs table and sends Telegram bot messages via the Bot API.
"""
from __future__ import annotations

import asyncio
import logging

from backend.settings import settings
from backend.notifier.worker import main


def _setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


if __name__ == "__main__":
    _setup_logging()
    asyncio.run(main())
