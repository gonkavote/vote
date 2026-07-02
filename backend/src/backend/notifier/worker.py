"""Long-running notifier worker.

Single-instance: one row picked per iteration, no concurrent sends.
Per-row state machine in `notification_jobs`:
    pending → running → done                      (sent OK)
    pending → running → skipped                   (recipient opted out, comment deleted, 403/400 from TG)
    pending → running → pending  (next_attempt_at) (transient: 429 or 5xx, attempts < max)
    pending → running → failed                    (after notification_max_attempts)

The 403 path also flips `users.notifications_disabled = true` so the user is
treated as opted-out for any future notifications.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from backend.ch import CHClient
from backend.notifications import (
    build_link,
    build_message,
    build_proposal_link,
    build_proposal_message,
    mark_user_opted_out,
)
from backend.notifier.telegram_client import TelegramError, send_message
from backend.settings import settings

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Job lifecycle
# ----------------------------------------------------------------------------

async def _pick_next_job(ch: CHClient) -> Optional[dict[str, Any]]:
    return await ch.query_one(
        """
        SELECT recipient_email, kind, source_comment_id, attempts, status,
               chat_id, target_entity_id, is_gov_proposal, proposal_id
        FROM gonka_vote.notification_jobs FINAL
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
    """Re-INSERT with the same merge key and a fresh updated_at.
    ReplacingMergeTree(updated_at) keeps the latest version on FINAL.
    Preserves enqueued_at + the pre-resolved chat_id / entity pointers."""
    existing = await ch.query_one(
        """
        SELECT enqueued_at
        FROM gonka_vote.notification_jobs FINAL
        WHERE recipient_email   = {email:String}
          AND kind              = {kind:String}
          AND source_comment_id = {cid:UUID}
        """,
        {"email": job["recipient_email"], "kind": job["kind"],
         "cid": str(job["source_comment_id"])},
    )
    enqueued_at = existing["enqueued_at"] if existing else datetime.now(timezone.utc)
    now = datetime.now(timezone.utc)
    await ch.insert(
        "notification_jobs",
        ["recipient_email", "kind", "source_comment_id", "status",
         "attempts", "last_error",
         "chat_id", "target_entity_id", "is_gov_proposal", "proposal_id",
         "enqueued_at", "started_at", "finished_at", "next_attempt_at",
         "updated_at"],
        [[
            job["recipient_email"], job["kind"], job["source_comment_id"],
            status, attempts, last_error,
            int(job["chat_id"]), job["target_entity_id"],
            bool(job["is_gov_proposal"]), int(job["proposal_id"]),
            enqueued_at, started_at, finished_at, next_attempt_at, now,
        ]],
    )


async def _mark_running(ch: CHClient, job: dict[str, Any]) -> None:
    await _upsert_job(
        ch, job, status="running",
        attempts=int(job.get("attempts") or 0),
        last_error="", started_at=datetime.now(timezone.utc),
        finished_at=None, next_attempt_at=None,
    )


async def _mark_done(ch: CHClient, job: dict[str, Any]) -> None:
    await _upsert_job(
        ch, job, status="done",
        attempts=int(job.get("attempts") or 0),
        last_error="", started_at=None,
        finished_at=datetime.now(timezone.utc), next_attempt_at=None,
    )


async def _mark_skipped(ch: CHClient, job: dict[str, Any], reason: str) -> None:
    await _upsert_job(
        ch, job, status="skipped",
        attempts=int(job.get("attempts") or 0),
        last_error=reason[:500], started_at=None,
        finished_at=datetime.now(timezone.utc), next_attempt_at=None,
    )


async def _retry_after(ch: CHClient, job: dict[str, Any], delay_sec: int,
                       err: str) -> None:
    """Transient failure: park as pending with a backoff. attempts is NOT
    incremented (e.g. 429 should be retried as many times as Telegram asks)."""
    next_at = datetime.now(timezone.utc) + timedelta(seconds=max(1, delay_sec))
    await _upsert_job(
        ch, job, status="pending",
        attempts=int(job.get("attempts") or 0),
        last_error=err[:500], started_at=None,
        finished_at=None, next_attempt_at=next_at,
    )


async def _mark_failed(ch: CHClient, job: dict[str, Any], err: str) -> None:
    now = datetime.now(timezone.utc)
    attempts = int(job.get("attempts") or 0) + 1
    if attempts >= settings.notification_max_attempts:
        new_status = "failed"
        next_at: Optional[datetime] = None
        logger.error(
            "notification %s/%s/%s failed permanently after %d attempts: %s",
            job["recipient_email"], job["kind"], job["source_comment_id"],
            attempts, err,
        )
    else:
        next_at = now + timedelta(seconds=settings.notification_retry_delay_sec)
        new_status = "pending"
        logger.warning(
            "notification %s/%s/%s failed (attempt %d/%d), retry in %ds: %s",
            job["recipient_email"], job["kind"], job["source_comment_id"],
            attempts, settings.notification_max_attempts,
            settings.notification_retry_delay_sec, err,
        )
    await _upsert_job(
        ch, job, status=new_status,
        attempts=attempts, last_error=err[:500],
        started_at=None, finished_at=now, next_attempt_at=next_at,
    )


# ----------------------------------------------------------------------------
# Per-job processing
# ----------------------------------------------------------------------------

async def _is_opted_out(ch: CHClient, email: str) -> bool:
    row = await ch.query_one(
        "SELECT notifications_disabled FROM gonka_vote.users FINAL "
        "WHERE email = {email:String}",
        {"email": email},
    )
    return bool(row and row.get("notifications_disabled"))


async def _load_comment(ch: CHClient, cid: UUID) -> Optional[dict[str, Any]]:
    """Load the triggering comment plus its author's display name.

    comments is a plain MergeTree (append-only), so FINAL is forbidden.
    But ALTER UPDATE source_lang / deleted_at can still settle later — we
    accept slightly stale reads here; the worst case is we skip a notif
    for an in-flight deletion. LIMIT 1 picks the original insert.
    """
    return await ch.query_one(
        """
        SELECT
            c.author_email AS author_email,
            c.body         AS body,
            COALESCE(u.name, c.author_name) AS author_name
        FROM gonka_vote.comments AS c
        LEFT JOIN gonka_vote.users AS u FINAL
               ON u.email = c.author_email
        WHERE c.id = {cid:UUID} AND c.deleted_at IS NULL
        LIMIT 1
        """,
        {"cid": str(cid)},
    )


async def _load_proposal_title(ch: CHClient, pid: int) -> Optional[str]:
    """Load the proposal title for a new-proposal notification. Returns None
    if the row is gone (shouldn't happen — poller writes them, never deletes)."""
    row = await ch.query_one(
        """
        SELECT title
        FROM gonka_vote.gov_proposals FINAL
        WHERE proposal_id = {pid:UInt32}
        LIMIT 1
        """,
        {"pid": int(pid)},
    )
    return row["title"] if row else None


async def _process_one(ch: CHClient, job: dict[str, Any]) -> None:
    """Send one notification. Marks the job done / skipped / retried / failed."""
    email = job["recipient_email"]
    kind = str(job["kind"])

    # 1. Re-check opt-out (could have flipped after enqueue).
    if await _is_opted_out(ch, email):
        await _mark_skipped(ch, job, "recipient opted out")
        return

    # 2. Build text — branch by kind.
    if kind == "gov_proposal_new":
        pid = int(job["proposal_id"])
        title = await _load_proposal_title(ch, pid)
        if title is None:
            await _mark_skipped(ch, job, "proposal missing")
            return
        link = build_proposal_link(
            base_url=settings.public_base_url, proposal_id=pid,
        )
        text = build_proposal_message(
            proposal_id=pid, title=str(title), link=link,
        )
    else:
        # Comment-driven kinds: 'reply_comment' / 'top_level_comment'.
        src = await _load_comment(ch, job["source_comment_id"])
        if not src:
            await _mark_skipped(ch, job, "source comment missing or deleted")
            return
        link = build_link(
            base_url=settings.public_base_url,
            is_gov=bool(job["is_gov_proposal"]),
            proposal_id=int(job["proposal_id"]),
            entity_id=str(job["target_entity_id"]),
            comment_id=job["source_comment_id"],
        )
        text = build_message(
            kind=kind,
            author_name=src.get("author_name"),
            body=str(src.get("body") or ""),
            link=link,
        )

    # 3. Send.
    try:
        await send_message(int(job["chat_id"]), text)
        await _mark_done(ch, job)
        logger.info("sent %s notification to %s (key=%s)",
                    kind, email, job["source_comment_id"])
        return
    except TelegramError as e:
        # 403 = bot blocked by user / user deactivated → auto-opt-out.
        if e.error_code == 403:
            try:
                await mark_user_opted_out(ch, email)
            except Exception as ee:
                logger.warning("mark_user_opted_out(%s) failed: %s", email, ee)
            await _mark_skipped(ch, job, f"403 {e.description}")
            logger.info("user %s blocked the bot → auto opt-out", email)
            return
        # 400 chat not found = stale chat id, give up cleanly.
        if e.error_code == 400 and "chat not found" in (e.description or "").lower():
            await _mark_skipped(ch, job, f"400 {e.description}")
            return
        # 429 rate limit: respect retry_after, don't grow attempts.
        if e.error_code == 429 or e.status_code == 429:
            delay = e.retry_after or settings.notification_retry_delay_sec
            await _retry_after(ch, job, delay,
                               f"429 retry_after={delay}: {e.description}")
            return
        # Anything else (5xx / 599 network / 400 we don't know) → retry/fail.
        await _mark_failed(ch, job, f"{e.error_code} {e.description}")
        return
    except Exception as e:
        await _mark_failed(ch, job, f"unexpected: {e}")
        return


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

async def _recover_running(ch: CHClient) -> int:
    """Re-queue any 'running' rows left over from a crashed previous instance.
    There's only ever one notifier process; anything still in 'running' is dead.
    """
    n = await ch.query_scalar(
        "SELECT count() FROM gonka_vote.notification_jobs FINAL "
        "WHERE status = 'running'"
    )
    n = int(n or 0)
    if n == 0:
        return 0
    await ch.command(
        """
        INSERT INTO gonka_vote.notification_jobs
            (recipient_email, kind, source_comment_id, status, attempts,
             last_error, chat_id, target_entity_id, is_gov_proposal,
             proposal_id, enqueued_at, started_at, finished_at,
             next_attempt_at, updated_at)
        SELECT recipient_email, kind, source_comment_id, 'pending', attempts,
               '', chat_id, target_entity_id, is_gov_proposal,
               proposal_id, enqueued_at, NULL, NULL, NULL, now64(3)
        FROM gonka_vote.notification_jobs FINAL
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

    logger.info("notifier: started, poll=%ds, max_attempts=%d",
                settings.notification_poll_interval,
                settings.notification_max_attempts)
    if not settings.telegram_bot_token:
        logger.warning("TELEGRAM_BOT_TOKEN is empty — sends will fail until configured")

    try:
        recovered = await _recover_running(ch)
        if recovered:
            logger.info("recovered %d stale 'running' job(s)", recovered)
    except Exception as e:
        logger.warning("startup recovery failed: %s", e)

    while True:
        try:
            job = await _pick_next_job(ch)
            if job is None:
                await asyncio.sleep(settings.notification_poll_interval)
                continue
            await _mark_running(ch, job)
            await _process_one(ch, job)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("notifier loop iteration failed: %s", e)
            await asyncio.sleep(settings.notification_poll_interval)
