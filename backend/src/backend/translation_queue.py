"""Helpers around the `translation_jobs` table.

Both the API (router.py) and the worker import from here.

Job kinds:
  - 'detect_proposal' / 'detect_comment' — created at INSERT time. Tells the
    worker to call the AI language detector, write source_lang back to
    proposals/comments, and enqueue per-language translation jobs.
  - 'proposal' / 'comment' — actual translation jobs, one per target_lang.

target_lang for detect jobs is set to '' (an arbitrary placeholder) so the
ORDER BY (kind, entity_id, target_lang) key stays unique.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from backend.ch import CHClient
from backend.lang_detect import supported_languages

logger = logging.getLogger(__name__)


DETECT_TARGET_LANG = ""  # Sentinel target_lang for kind='detect_*' rows.


async def enqueue_translations(
    ch: CHClient, kind: str, entity_id: UUID, source_lang: str,
) -> int:
    """Create translation_jobs rows for every supported language ≠ source.

    Returns the number of rows inserted (0 if there's nothing to translate).
    Called by the worker after AI language detection resolves source_lang.
    """
    targets = [lang for lang in supported_languages() if lang != source_lang]
    if not targets:
        return 0
    now = datetime.now(timezone.utc)
    rows: list[list[Any]] = [
        [kind, entity_id, lang, "pending", 0, "", now, None, None, None, now]
        for lang in targets
    ]
    await ch.insert(
        "translation_jobs",
        ["kind", "entity_id", "target_lang", "status", "attempts", "last_error",
         "enqueued_at", "started_at", "finished_at", "next_attempt_at", "updated_at"],
        rows,
    )
    logger.info("enqueued %d translation job(s) for %s %s (source=%s)",
                len(targets), kind, entity_id, source_lang)
    return len(targets)


async def enqueue_detect(ch: CHClient, kind: str, entity_id: UUID) -> None:
    """Create a single 'detect_<kind>' job. Worker resolves source_lang and
    follows up by calling enqueue_translations()."""
    now = datetime.now(timezone.utc)
    await ch.insert(
        "translation_jobs",
        ["kind", "entity_id", "target_lang", "status", "attempts", "last_error",
         "enqueued_at", "started_at", "finished_at", "next_attempt_at", "updated_at"],
        [[f"detect_{kind}", entity_id, DETECT_TARGET_LANG,
          "pending", 0, "", now, None, None, None, now]],
    )
    logger.info("enqueued detect job for %s %s", kind, entity_id)


async def has_any_job(ch: CHClient, entity_id: UUID) -> bool:
    """True if any translation_jobs row (any kind/status) exists for the
    entity. Used to detect an entity whose initial enqueue was lost — its
    text never changes again, so the normal enqueue-on-change path can't
    self-heal it."""
    row = await ch.query_one(
        """
        SELECT count() AS n
        FROM gonka_vote.translation_jobs
        WHERE entity_id = {eid:UUID}
        """,
        {"eid": str(entity_id)},
    )
    return bool(row and int(row.get("n", 0)) > 0)
