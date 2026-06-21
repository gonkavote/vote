"""Entrypoint: `python -m backend.translator`.

Run as a separate Docker service (gonka-vote-translator). Polls the
translation_jobs table and pushes finished translations into tenders.*_t
or comments.body_t.
"""
from __future__ import annotations

import asyncio
import logging

from backend.settings import settings
from backend.translator.worker import main


def _setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


if __name__ == "__main__":
    _setup_logging()
    asyncio.run(main())
