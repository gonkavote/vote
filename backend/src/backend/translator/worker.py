"""Long-running translator worker.

Single-instance design: one row picked per iteration, no concurrent jobs.
Gemini is rate-limited per key and we want strict fallback ordering, so
serial processing also keeps the key×model cascade clean.

State machine for one row in `translation_jobs`:
    pending → running → done             (happy path)
    pending → running → pending          (transient failure, retry with backoff)
    pending → running → failed           (after translation_max_attempts)
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from backend.ch import CHClient
from backend.governance.cache import proposal_id_from_uuid
from backend.lang_detect import detect_lang, supported_languages
from backend.settings import settings
from backend.translation_queue import enqueue_translations
from backend.translator.gemini_client import detect_lang_via_ai, translate
from backend.translator.prompts import (
    build_comment_prompt,
    build_gov_metadata_prompt,
    build_gov_proposal_prompt,
    build_proposal_prompt,
)

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Job lifecycle helpers
# ----------------------------------------------------------------------------

async def _pick_next_job(ch: CHClient) -> Optional[dict[str, Any]]:
    """Atomic-ish: read the oldest pending job whose backoff has elapsed.

    Single-worker design means we don't need a real lock. If we ever scale
    to N workers, switch to `attempts` as an optimistic-lock token.
    """
    return await ch.query_one(
        """
        SELECT kind, entity_id, target_lang, attempts, status
        FROM gonka_vote.translation_jobs FINAL
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now64(3))
        ORDER BY enqueued_at ASC
        LIMIT 1
        """
    )


async def _upsert_job(
    ch: CHClient,
    job: dict[str, Any],
    *,
    status: str,
    attempts: int,
    last_error: str,
    started_at: Optional[datetime],
    finished_at: Optional[datetime],
    next_attempt_at: Optional[datetime],
) -> None:
    """Re-INSERT the row with the same ORDER BY key and a fresh `updated_at`.

    ReplacingMergeTree merges on (kind, entity_id, target_lang) keeping the
    row with the largest `updated_at`. ALTER ... UPDATE is forbidden on the
    version column itself, so we INSERT instead — semantically equivalent
    for our usage (always SELECT ... FINAL).
    """
    # Preserve enqueued_at from the existing row if we can get it cheaply.
    # Falling back to now() would change ordering; safer to read it once.
    existing = await ch.query_one(
        "SELECT enqueued_at FROM gonka_vote.translation_jobs FINAL "
        "WHERE kind = {kind:String} AND entity_id = {id:UUID} "
        "AND target_lang = {lang:String}",
        {"kind": job["kind"], "id": str(job["entity_id"]),
         "lang": job["target_lang"]},
    )
    enqueued_at = existing["enqueued_at"] if existing else datetime.now(timezone.utc)
    now = datetime.now(timezone.utc)
    await ch.insert(
        "translation_jobs",
        ["kind", "entity_id", "target_lang", "status", "attempts", "last_error",
         "enqueued_at", "started_at", "finished_at", "next_attempt_at", "updated_at"],
        [[job["kind"], job["entity_id"], job["target_lang"], status, attempts,
          last_error, enqueued_at, started_at, finished_at, next_attempt_at, now]],
    )


async def _mark_running(ch: CHClient, job: dict[str, Any]) -> None:
    await _upsert_job(
        ch, job,
        status="running", attempts=int(job.get("attempts") or 0),
        last_error="", started_at=datetime.now(timezone.utc),
        finished_at=None, next_attempt_at=None,
    )


async def _mark_done(ch: CHClient, job: dict[str, Any]) -> None:
    await _upsert_job(
        ch, job,
        status="done", attempts=int(job.get("attempts") or 0),
        last_error="", started_at=None,
        finished_at=datetime.now(timezone.utc), next_attempt_at=None,
    )


async def _mark_failed(ch: CHClient, job: dict[str, Any], err: str) -> None:
    now = datetime.now(timezone.utc)
    attempts = int(job.get("attempts") or 0) + 1
    if attempts >= settings.translation_max_attempts:
        # Permanent failure — UI will silently fall back to the original.
        new_status = "failed"
        next_at: Optional[datetime] = None
        logger.error("job %s/%s/%s failed permanently after %d attempts: %s",
                     job["kind"], job["entity_id"], job["target_lang"], attempts, err)
    else:
        # Exponential backoff: 30s, 1m, 2m, 4m, 8m … capped at 1h.
        delay = min(30 * (2 ** (attempts - 1)), 3600)
        next_at = now + timedelta(seconds=delay)
        new_status = "pending"
        logger.warning("job %s/%s/%s failed (attempt %d/%d), retry in %ds: %s",
                       job["kind"], job["entity_id"], job["target_lang"],
                       attempts, settings.translation_max_attempts, delay, err)
    await _upsert_job(
        ch, job,
        status=new_status, attempts=attempts,
        last_error=err[:500], started_at=None,
        finished_at=now, next_attempt_at=next_at,
    )


# ----------------------------------------------------------------------------
# Per-kind processing
# ----------------------------------------------------------------------------

async def _load_proposal_source(ch: CHClient, tid: UUID) -> Optional[dict[str, Any]]:
    return await ch.query_one(
        """
        SELECT id, title, summary, description, source_lang
        FROM gonka_vote.proposals FINAL
        WHERE id = {id:UUID} AND deleted_at IS NULL
        """,
        {"id": str(tid)},
    )


async def _load_comment_source(ch: CHClient, cid: UUID) -> Optional[dict[str, Any]]:
    # comments uses plain MergeTree (append-only), so FINAL is illegal.
    # Mutations (e.g. ALTER UPDATE source_lang) take effect after the next
    # merge; reading without FINAL is fine because the row is immutable
    # except for the updated columns.
    return await ch.query_one(
        """
        SELECT id, body, source_lang
        FROM gonka_vote.comments
        WHERE id = {id:UUID} AND deleted_at IS NULL
        LIMIT 1
        """,
        {"id": str(cid)},
    )


async def _resolve_source_lang(
    ch: CHClient, table: str, eid: UUID, current: str, sample_text: str,
) -> str:
    """If source_lang is blank, detect via AI (fallback: offline langdetect)
    and persist the result. Returns the resolved code."""
    if current:
        return current
    code = await detect_lang_via_ai(sample_text, supported_languages())
    if not code:
        code = detect_lang(sample_text)
        logger.info("AI detect failed for %s/%s, fell back to langdetect=%s",
                    table, eid, code)
    await ch.command(
        f"ALTER TABLE gonka_vote.{table} UPDATE source_lang = {{lang:String}} "
        "WHERE id = {id:UUID}",
        {"lang": code, "id": str(eid)},
    )
    logger.info("set %s.source_lang for %s = %s", table, eid, code)
    return code


def _merge_into_json(existing_json_str: str, lang: str, value: str) -> str:
    """Merge {lang: value} into an existing JSON object stored in CH.

    CH JSON columns serialize as JSON via `toString()`. We round-trip through
    Python so we don't depend on `JSONMergePatch` availability in older CH.
    """
    try:
        obj = json.loads(existing_json_str) if existing_json_str else {}
        if not isinstance(obj, dict):
            obj = {}
    except json.JSONDecodeError:
        obj = {}
    obj[lang] = value
    return json.dumps(obj, ensure_ascii=False)


async def _process_proposal(ch: CHClient, job: dict[str, Any]) -> None:
    tid: UUID = job["entity_id"]
    target = job["target_lang"]
    row = await _load_proposal_source(ch, tid)
    if not row:
        # Tender was soft-deleted; nothing to translate.
        logger.info("proposal %s missing or deleted, skipping", tid)
        return

    sample = f"{row['title']} {row.get('summary') or ''} {row.get('description') or ''}"
    source_lang = await _resolve_source_lang(
        ch, "proposals", tid, row.get("source_lang") or "", sample,
    )
    if source_lang == target:
        logger.info("proposal %s source==target=%s, no translate needed", tid, target)
        return

    user_payload = json.dumps({
        "title": row["title"],
        "summary": row.get("summary") or "",
        "description": row.get("description") or "",
    }, ensure_ascii=False)
    system_prompt = build_proposal_prompt(source_lang, target)
    result = await translate(system_prompt, user_payload)

    title_new = str(result.get("title", row["title"]))
    summary_new = str(result.get("summary", row.get("summary") or ""))
    desc_new = str(result.get("description", row.get("description") or ""))

    await ch.insert(
        "proposal_translations",
        ["proposal_id", "target_lang", "title", "summary", "description", "updated_at"],
        [[tid, target, title_new, summary_new, desc_new, datetime.now(timezone.utc)]],
    )
    logger.info("translated proposal %s %s→%s", tid, source_lang, target)


async def _process_comment(ch: CHClient, job: dict[str, Any]) -> None:
    cid: UUID = job["entity_id"]
    target = job["target_lang"]
    row = await _load_comment_source(ch, cid)
    if not row:
        logger.info("comment %s missing or deleted, skipping", cid)
        return

    source_lang = await _resolve_source_lang(
        ch, "comments", cid, row.get("source_lang") or "", row["body"],
    )
    if source_lang == target:
        logger.info("comment %s source==target=%s, no translate needed", cid, target)
        return

    user_payload = json.dumps({"body": row["body"]}, ensure_ascii=False)
    system_prompt = build_comment_prompt(source_lang, target)
    result = await translate(system_prompt, user_payload)

    body_new = str(result.get("body", row["body"]))
    await ch.insert(
        "comment_translations",
        ["comment_id", "target_lang", "body", "updated_at"],
        [[cid, target, body_new, datetime.now(timezone.utc)]],
    )
    logger.info("translated comment %s %s→%s", cid, source_lang, target)


async def _process_detect_proposal(ch: CHClient, job: dict[str, Any]) -> None:
    tid: UUID = job["entity_id"]
    row = await _load_proposal_source(ch, tid)
    if not row:
        logger.info("detect: proposal %s missing or deleted, skipping", tid)
        return
    sample = f"{row['title']} {row.get('summary') or ''} {row.get('description') or ''}"
    source_lang = await _resolve_source_lang(
        ch, "proposals", tid, row.get("source_lang") or "", sample,
    )
    n = await enqueue_translations(ch, "proposal", tid, source_lang)
    logger.info("detect proposal %s → source=%s, enqueued %d translation(s)",
                tid, source_lang, n)


async def _process_detect_comment(ch: CHClient, job: dict[str, Any]) -> None:
    cid: UUID = job["entity_id"]
    row = await _load_comment_source(ch, cid)
    if not row:
        logger.info("detect: comment %s missing or deleted, skipping", cid)
        return
    source_lang = await _resolve_source_lang(
        ch, "comments", cid, row.get("source_lang") or "", row["body"],
    )
    n = await enqueue_translations(ch, "comment", cid, source_lang)
    logger.info("detect comment %s → source=%s, enqueued %d translation(s)",
                cid, source_lang, n)


# ----------------------------------------------------------------------------
# Governance — proposal title/summary/failed_reason
# ----------------------------------------------------------------------------

async def _load_gov_proposal_source(ch: CHClient, pid: int) -> Optional[dict[str, Any]]:
    return await ch.query_one(
        """
        SELECT proposal_id,
               title, summary, failed_reason, source_lang
        FROM gonka_vote.gov_proposals FINAL
        WHERE proposal_id = {pid:UInt32}
        """,
        {"pid": pid},
    )


async def _resolve_gov_source_lang(
    ch: CHClient, pid: int, current: str, sample: str,
) -> str:
    if current:
        return current
    code = await detect_lang_via_ai(sample, supported_languages())
    if not code:
        code = detect_lang(sample)
        logger.info("AI detect failed for gov_proposal %s, langdetect=%s", pid, code)
    await ch.command(
        "ALTER TABLE gonka_vote.gov_proposals UPDATE source_lang = {lang:String} "
        "WHERE proposal_id = {pid:UInt32}",
        {"lang": code, "pid": pid},
    )
    logger.info("set gov_proposals.source_lang for %s = %s", pid, code)
    return code


async def _process_detect_gov_proposal(ch: CHClient, job: dict[str, Any]) -> None:
    pid = proposal_id_from_uuid(job["entity_id"])
    row = await _load_gov_proposal_source(ch, pid)
    if not row:
        logger.info("detect: gov_proposal %s missing, skipping", pid)
        return
    sample = (
        f"{row.get('title') or ''} {row.get('summary') or ''} "
        f"{row.get('failed_reason') or ''}"
    )
    source_lang = await _resolve_gov_source_lang(
        ch, pid, row.get("source_lang") or "", sample,
    )
    n = await enqueue_translations(ch, "gov_proposal", job["entity_id"], source_lang)
    logger.info("detect gov_proposal %s → source=%s, enqueued %d translation(s)",
                pid, source_lang, n)


async def _process_gov_proposal(ch: CHClient, job: dict[str, Any]) -> None:
    pid = proposal_id_from_uuid(job["entity_id"])
    target = job["target_lang"]
    row = await _load_gov_proposal_source(ch, pid)
    if not row:
        logger.info("gov_proposal %s missing, skipping", pid)
        return
    sample = (
        f"{row.get('title') or ''} {row.get('summary') or ''} "
        f"{row.get('failed_reason') or ''}"
    )
    source_lang = await _resolve_gov_source_lang(
        ch, pid, row.get("source_lang") or "", sample,
    )
    if source_lang == target:
        logger.info("gov_proposal %s source==target=%s, skip", pid, target)
        return

    user_payload = json.dumps({
        "title": row.get("title") or "",
        "summary": row.get("summary") or "",
        "failed_reason": row.get("failed_reason") or "",
    }, ensure_ascii=False)
    system_prompt = build_gov_proposal_prompt(source_lang, target)
    result = await translate(system_prompt, user_payload)

    title_new = str(result.get("title", row.get("title") or ""))
    summary_new = str(result.get("summary", row.get("summary") or ""))
    failed_new = str(result.get("failed_reason", row.get("failed_reason") or ""))

    await ch.insert(
        "gov_proposal_translations",
        ["proposal_id", "target_lang", "title", "summary", "failed_reason", "updated_at"],
        [[pid, target, title_new, summary_new, failed_new, datetime.now(timezone.utc)]],
    )
    logger.info("translated gov_proposal %s %s→%s", pid, source_lang, target)


# ----------------------------------------------------------------------------
# Governance — metadata (GitHub README)
# ----------------------------------------------------------------------------

async def _load_gov_metadata_source(ch: CHClient, pid: int) -> Optional[dict[str, Any]]:
    return await ch.query_one(
        """
        SELECT proposal_id, markdown,
               markdown_t AS markdown_t_json
        FROM gonka_vote.gov_metadata FINAL
        WHERE proposal_id = {pid:UInt32}
        """,
        {"pid": pid},
    )


async def _resolve_gov_metadata_source_lang(
    ch: CHClient, pid: int, sample: str,
) -> str:
    """gov_metadata has no source_lang column; we re-detect each time the
    text changed. The job is enqueued only on actual content change, so the
    AI call is rare."""
    code = await detect_lang_via_ai(sample, supported_languages())
    if not code:
        code = detect_lang(sample)
    return code


async def _process_detect_gov_metadata(ch: CHClient, job: dict[str, Any]) -> None:
    pid = proposal_id_from_uuid(job["entity_id"])
    row = await _load_gov_metadata_source(ch, pid)
    if not row:
        logger.info("detect: gov_metadata %s missing, skipping", pid)
        return
    md = row.get("markdown") or ""
    if not md.strip():
        return
    source_lang = await _resolve_gov_metadata_source_lang(ch, pid, md[:2000])
    n = await enqueue_translations(ch, "gov_metadata", job["entity_id"], source_lang)
    logger.info("detect gov_metadata %s → source=%s, enqueued %d translation(s)",
                pid, source_lang, n)


async def _process_gov_metadata(ch: CHClient, job: dict[str, Any]) -> None:
    pid = proposal_id_from_uuid(job["entity_id"])
    target = job["target_lang"]
    row = await _load_gov_metadata_source(ch, pid)
    if not row:
        logger.info("gov_metadata %s missing, skipping", pid)
        return
    md = row.get("markdown") or ""
    if not md.strip():
        return
    # gov_metadata has no source_lang column — re-detect on the fly.
    source_lang = await _resolve_gov_metadata_source_lang(ch, pid, md[:2000])
    if source_lang == target:
        logger.info("gov_metadata %s source==target=%s, skip", pid, target)
        return

    user_payload = json.dumps({"markdown": md}, ensure_ascii=False)
    system_prompt = build_gov_metadata_prompt(source_lang, target)
    result = await translate(system_prompt, user_payload)
    md_new = str(result.get("markdown", md))
    markdown_t = _merge_into_json(row.get("markdown_t_json") or "", target, md_new)
    await ch.command(
        "ALTER TABLE gonka_vote.gov_metadata UPDATE markdown_t = {md:String} "
        "WHERE proposal_id = {pid:UInt32}",
        {"md": markdown_t, "pid": pid},
    )
    logger.info("translated gov_metadata %s %s→%s", pid, source_lang, target)


async def _process_one(ch: CHClient, job: dict[str, Any]) -> None:
    kind = job["kind"]
    if kind == "proposal":
        await _process_proposal(ch, job)
    elif kind == "comment":
        await _process_comment(ch, job)
    elif kind == "detect_proposal":
        await _process_detect_proposal(ch, job)
    elif kind == "detect_comment":
        await _process_detect_comment(ch, job)
    elif kind == "gov_proposal":
        await _process_gov_proposal(ch, job)
    elif kind == "detect_gov_proposal":
        await _process_detect_gov_proposal(ch, job)
    elif kind == "gov_metadata":
        await _process_gov_metadata(ch, job)
    elif kind == "detect_gov_metadata":
        await _process_detect_gov_metadata(ch, job)
    else:
        raise RuntimeError(f"unknown job kind: {kind}")


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

async def _recover_running(ch: CHClient) -> int:
    """Re-queue any 'running' rows left over from a crashed previous instance.

    There's only ever one translator process, so anything still in 'running'
    when we start up is dead. Re-INSERT them as 'pending' with the original
    enqueued_at preserved, ready to be picked up on the next loop iteration.
    """
    n = await ch.query_scalar(
        "SELECT count() FROM gonka_vote.translation_jobs FINAL "
        "WHERE status = 'running'"
    )
    n = int(n or 0)
    if n == 0:
        return 0
    await ch.command(
        """
        INSERT INTO gonka_vote.translation_jobs
            (kind, entity_id, target_lang, status, attempts, last_error,
             enqueued_at, started_at, finished_at, next_attempt_at, updated_at)
        SELECT kind, entity_id, target_lang, 'pending', attempts, '',
               enqueued_at, NULL, NULL, NULL, now64(3)
        FROM gonka_vote.translation_jobs FINAL
        WHERE status = 'running'
        """
    )
    return n


async def main() -> None:
    ch = CHClient(
        host=settings.clickhouse_host,
        port=settings.clickhouse_http_port,
        database=settings.clickhouse_database,
        username=settings.clickhouse_user,
        password=settings.clickhouse_password,
    )
    await ch.connect()

    from backend.lang_detect import supported_languages
    logger.info("translator: started, languages=%s, poll=%ds, max_attempts=%d",
                supported_languages(),
                settings.translation_poll_interval,
                settings.translation_max_attempts)
    if not (settings.gemini_api_key_1 or settings.gemini_api_key_2 or settings.gemini_api_key_3):
        logger.warning("no GEMINI_API_KEY_* configured — jobs will fail until keys are set")

    try:
        recovered = await _recover_running(ch)
        if recovered:
            logger.info("recovered %d stale 'running' job(s) from a previous crash", recovered)
    except Exception as e:
        logger.warning("startup recovery failed: %s", e)

    while True:
        try:
            job = await _pick_next_job(ch)
        except Exception as e:
            logger.error("pick_next_job failed: %s", e)
            await asyncio.sleep(settings.translation_poll_interval)
            continue

        if not job:
            await asyncio.sleep(settings.translation_poll_interval)
            continue

        logger.info("picked job kind=%s id=%s lang=%s attempts=%d",
                    job["kind"], job["entity_id"], job["target_lang"], job.get("attempts") or 0)
        try:
            await _mark_running(ch, job)
            await _process_one(ch, job)
            await _mark_done(ch, job)
        except Exception as e:
            try:
                await _mark_failed(ch, job, str(e))
            except Exception as e2:
                logger.error("mark_failed itself failed: %s (original: %s)", e2, e)
