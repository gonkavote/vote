"""One-shot: enqueue detect jobs for proposals/comments that have no source_lang.

Run after applying migrations 009 + 010 on a database that already had
content. Idempotent: rows with non-empty `source_lang` are skipped.

Usage (host):
    docker compose run --rm translator python -m backend.scripts.backfill_source_lang

The translator service then picks up each detect job, calls Gemini to
identify the language, persists source_lang, and enqueues the per-language
translation jobs. (Earlier versions of this script ran langdetect inline,
but that produced wrong results on short Russian comments with Latin
loanwords — see lang_detect.py docstring.)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from backend.ch import CHClient
from backend.lang_detect import supported_languages
from backend.settings import settings
from backend.translation_queue import enqueue_detect

logger = logging.getLogger(__name__)


async def _backfill_proposals(ch: CHClient) -> int:
    rows: list[dict[str, Any]] = await ch.query_rows(
        """
        SELECT id FROM gonka_vote.proposals FINAL
        WHERE deleted_at IS NULL AND (source_lang = '' OR source_lang IS NULL)
        """
    )
    for r in rows:
        await enqueue_detect(ch, "proposal", r["id"])
    return len(rows)


async def _backfill_comments(ch: CHClient) -> int:
    rows: list[dict[str, Any]] = await ch.query_rows(
        """
        SELECT id FROM gonka_vote.comments
        WHERE deleted_at IS NULL AND (source_lang = '' OR source_lang IS NULL)
        """
    )
    for r in rows:
        await enqueue_detect(ch, "comment", r["id"])
    return len(rows)


async def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logger.info("backfill: languages=%s", supported_languages())
    ch = CHClient(
        host=settings.clickhouse_host,
        port=settings.clickhouse_http_port,
        database=settings.clickhouse_database,
        username=settings.clickhouse_user,
        password=settings.clickhouse_password,
    )
    await ch.connect()

    n_proposals = await _backfill_proposals(ch)
    n_comments = await _backfill_comments(ch)
    logger.info("done: enqueued detect for %d proposal(s), %d comment(s)",
                n_proposals, n_comments)


if __name__ == "__main__":
    asyncio.run(main())
