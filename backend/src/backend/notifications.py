"""Telegram notification enqueue + shared helpers.

Imported from router.add_comment and governance.router.add_proposal_comment
after a comment row is INSERTed. The actual sendMessage call lives in
backend.notifier.worker.

Recipients of a notification are determined here, filtered for
opt-out / Google users, and persisted into `notification_jobs`. The worker
service then picks pending rows, formats the message via build_message()
below, and sends them through the Bot API.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from backend.ch import CHClient

logger = logging.getLogger(__name__)

# Telegram-login users get an email of the form "tg:{tg_id}@telegram.local"
# where tg_id is the numeric Telegram user id. That id doubles as the chat_id
# for bot direct messages.
TG_EMAIL_RE = re.compile(r"^tg:(\d+)@telegram\.local$")

# Governance proposals don't have a UUID — we synthesize one from proposal_id
# (see governance.router._proposal_owner_uuid). This regex recovers the int.
GOV_OWNER_UUID_RE = re.compile(r"^00000000-0000-0000-0000-([0-9a-fA-F]{12})$")


def tg_chat_id_from_email(email: str) -> Optional[int]:
    """Return the numeric TG chat id, or None for Google users."""
    m = TG_EMAIL_RE.match(email or "")
    return int(m.group(1)) if m else None


def proposal_id_from_owner_uuid(owner_uuid: str) -> Optional[int]:
    """Decode '00000000-0000-0000-0000-{pid:012x}' back into proposal_id."""
    m = GOV_OWNER_UUID_RE.match(owner_uuid or "")
    return int(m.group(1), 16) if m else None


def owner_uuid_for_proposal(proposal_id: int) -> UUID:
    """Synthetic UUID used as source_comment_id for gov-proposal notifications.
    Lets notification_jobs' ORDER BY (recipient, kind, source_comment_id)
    dedupe one notification per (user, proposal) without a schema change."""
    return UUID(f"00000000-0000-0000-0000-{proposal_id:012x}")


async def enqueue_comment_notifications(ch: CHClient, comment_id: UUID) -> None:
    """Enqueue 0–2 notification_jobs for a freshly-inserted comment.

    MUST never raise — the API response can't fail because of a notification
    bookkeeping issue. All exceptions are logged and swallowed.

    Recipients:
      * parent_comment.author        — if there is a parent (a reply)
      * proposal.creator             — only for top-level comments on community
                                       proposals (gov proposals have no site-side owner)
    Skipped if:
      * recipient == comment author       (self-notify)
      * recipient is a Google user        (no Telegram chat id)
      * recipient has notifications_disabled
    """
    try:
        row = await ch.query_one(
            """
            SELECT
                c.author_email                AS author_email,
                c.entity_id                   AS entity_id,
                c.parent_comment_id           AS parent_comment_id,
                t.creator_email               AS proposal_author,
                pc.author_email               AS parent_author
            FROM gonka_vote.comments AS c
            LEFT JOIN gonka_vote.proposals AS t FINAL
                   ON t.id = c.entity_id
            LEFT JOIN gonka_vote.comments AS pc
                   ON pc.id = c.parent_comment_id AND pc.deleted_at IS NULL
            WHERE c.id = {cid:UUID}
            LIMIT 1
            """,
            {"cid": str(comment_id)},
        )
        if not row:
            return

        entity_uuid_str = str(row["entity_id"])
        pid = proposal_id_from_owner_uuid(entity_uuid_str)
        is_gov = pid is not None
        author = row["author_email"]
        parent_author = row.get("parent_author")
        proposal_author = row.get("proposal_author")
        has_parent = row.get("parent_comment_id") is not None

        # Build (email, kind) recipient pairs.
        recipients: list[tuple[str, str]] = []
        if parent_author and parent_author != author:
            recipients.append((parent_author, "reply_comment"))
        if (
            not is_gov
            and proposal_author
            and proposal_author != author
            and not has_parent                       # only top-level
            and proposal_author != parent_author     # dedup with reply notif
        ):
            recipients.append((proposal_author, "top_level_comment"))

        if not recipients:
            return

        # Filter to TG users that haven't opted out.
        emails = list({e for e, _ in recipients})
        flag_rows = await ch.query_rows(
            """
            SELECT email, notifications_disabled
            FROM gonka_vote.users FINAL
            WHERE email IN {emails:Array(String)}
            """,
            {"emails": emails},
        )
        flags = {r["email"]: bool(r.get("notifications_disabled")) for r in flag_rows}

        now = datetime.now(timezone.utc)
        to_insert: list[list] = []
        for email, kind in recipients:
            chat_id = tg_chat_id_from_email(email)
            if chat_id is None:
                continue
            if flags.get(email, False):
                continue
            to_insert.append([
                email, kind, comment_id, "pending", 0, "",
                chat_id, row["entity_id"], is_gov, (pid or 0),
                now, None, None, None, now,
            ])

        if not to_insert:
            return
        await ch.insert(
            "notification_jobs",
            ["recipient_email", "kind", "source_comment_id", "status",
             "attempts", "last_error",
             "chat_id", "target_entity_id", "is_gov_proposal", "proposal_id",
             "enqueued_at", "started_at", "finished_at", "next_attempt_at",
             "updated_at"],
            to_insert,
        )
        logger.info("enqueued %d notification(s) for comment %s",
                    len(to_insert), comment_id)
    except Exception as e:
        logger.warning("enqueue_comment_notifications failed for %s: %s",
                       comment_id, e)


async def enqueue_new_proposal_notifications(
    ch: CHClient, proposal_id: int,
) -> None:
    """Fan out one Telegram notification per TG-logged-in, non-opted-out user
    for a freshly-discovered governance proposal in `voting` status.

    Called from cache.upsert_proposal ONCE per proposal — when we INSERT a
    new row whose status is 'voting'. Idempotency is guaranteed by the
    notification_jobs merge key (recipient_email, kind, source_comment_id):
    we use a synthetic comment_id derived from proposal_id so a retried
    enqueue collapses to the same row on ReplacingMergeTree.

    MUST never raise — caller is the poller's hot path. All exceptions
    logged + swallowed.
    """
    try:
        rows = await ch.query_rows(
            """
            SELECT email
            FROM gonka_vote.users FINAL
            WHERE notifications_disabled = false
              AND email LIKE 'tg:%'
            """
        )
        if not rows:
            return

        source_id = owner_uuid_for_proposal(proposal_id)
        # target_entity_id is unused for gov notifications but the column is
        # non-nullable, so reuse the same synthetic UUID.
        target_entity_id = source_id
        now = datetime.now(timezone.utc)

        to_insert: list[list] = []
        for row in rows:
            email = row["email"]
            chat_id = tg_chat_id_from_email(email)
            if chat_id is None:
                continue
            to_insert.append([
                email, "gov_proposal_new", source_id, "pending", 0, "",
                chat_id, target_entity_id, True, proposal_id,
                now, None, None, None, now,
            ])

        if not to_insert:
            return
        await ch.insert(
            "notification_jobs",
            ["recipient_email", "kind", "source_comment_id", "status",
             "attempts", "last_error",
             "chat_id", "target_entity_id", "is_gov_proposal", "proposal_id",
             "enqueued_at", "started_at", "finished_at", "next_attempt_at",
             "updated_at"],
            to_insert,
        )
        logger.info(
            "enqueued %d new-proposal notification(s) for proposal %d",
            len(to_insert), proposal_id,
        )
    except Exception as e:
        logger.warning(
            "enqueue_new_proposal_notifications(%s) failed: %s",
            proposal_id, e,
        )


# ----------------------------------------------------------------------------
# Text + link formatting (used by the worker)
# ----------------------------------------------------------------------------

def build_link(*, base_url: str, is_gov: bool, proposal_id: int,
               entity_id: str, comment_id: UUID) -> str:
    base = base_url.rstrip("/")
    if is_gov:
        return f"{base}/governance/{proposal_id}#comment-{comment_id}"
    return f"{base}/proposal/{entity_id}#comment-{comment_id}"


def build_proposal_link(*, base_url: str, proposal_id: int) -> str:
    return f"{base_url.rstrip('/')}/governance/{proposal_id}"


def build_proposal_message(*, proposal_id: int, title: str, link: str) -> str:
    """Notification for a new governance proposal entering the voting phase.
    No summary on purpose — keeps the message short and the link does the
    talking."""
    title = (title or "").strip().replace("\n", " ") or f"Proposal #{proposal_id}"
    if len(title) > 200:
        title = title[:200].rstrip() + "…"
    return (
        f"\U0001F4CA New governance proposal #{proposal_id}: {title}\n\n"
        f"{link}\n\n"
        f"Reply /stop to disable notifications."
    )


def build_message(*, kind: str, author_name: Optional[str], body: str,
                  link: str) -> str:
    who = (author_name or "").strip() or "Someone"
    preview = (body or "").strip().replace("\n", " ").replace("\r", " ")
    if len(preview) > 200:
        preview = preview[:200].rstrip() + "…"
    if kind == "reply_comment":
        head = f"{who} replied to your comment"
    else:
        head = f"{who} commented on your proposal"
    return (
        f"{head}:\n\n{preview}\n\n{link}\n\n"
        f"Reply /stop to disable notifications."
    )


# ----------------------------------------------------------------------------
# Opt-out / opt-in helpers (used by webhook handler and 403-handling in worker)
# ----------------------------------------------------------------------------

async def set_user_opt_out(ch: CHClient, email: str, disabled: bool) -> bool:
    """Toggle notifications_disabled for an existing user. Returns True if a
    row was rewritten, False if the email is unknown (we don't auto-create
    users — only Telegram-login does that).

    Preserves uid, wallet_address, name, image, is_admin via read-modify-write
    against the ReplacingMergeTree(updated_at) `users` table.
    """
    existing = await ch.query_one(
        """
        SELECT uid, name, image, wallet_address, is_admin
        FROM gonka_vote.users FINAL
        WHERE email = {email:String}
        """,
        {"email": email},
    )
    if not existing:
        return False
    await ch.insert(
        "users",
        ["email", "name", "image", "wallet_address", "uid", "is_admin",
         "notifications_disabled"],
        [[
            email, existing.get("name"), existing.get("image"),
            existing.get("wallet_address"), existing["uid"],
            bool(existing.get("is_admin")), bool(disabled),
        ]],
    )
    return True


async def mark_user_opted_out(ch: CHClient, email: str) -> None:
    """Convenience wrapper for the 403/blocked-by-user path."""
    await set_user_opt_out(ch, email, True)
