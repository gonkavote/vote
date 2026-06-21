"""Read/write helpers around the gov_* tables.

The poller calls `upsert_proposal` etc. and we trigger a translation job
when the user-facing text actually changed (avoids re-translating untouched
proposals on every 60 s tick).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from backend.ch import CHClient
from backend.governance.models import normalize_status
from backend.notifications import enqueue_new_proposal_notifications
from backend.translation_queue import enqueue_detect, has_any_job

logger = logging.getLogger(__name__)


# translation_jobs.entity_id is a UUID. Governance proposal IDs are small
# unsigned ints — encode them losslessly into the last 12 hex digits of an
# all-zeros UUID. This sidesteps a separate id-mapping table and lets the
# worker recover the int with a single regex.
def proposal_uuid(proposal_id: int, kind: str = "gov_proposal") -> UUID:
    """Reversible UUID encoding of a proposal_id."""
    if proposal_id < 0 or proposal_id > 0xFFFFFFFFFFFF:
        raise ValueError(f"proposal_id {proposal_id} out of range")
    # Stash kind in the version-nibble area too, but we don't need to recover
    # it (the job row already carries `kind`). Just encode pid in the suffix.
    _ = kind
    return UUID(f"00000000-0000-0000-0000-{proposal_id:012x}")


def proposal_id_from_uuid(u: UUID) -> int:
    return int(u.hex[-12:], 16)


# ----------------------------------------------------------------------------
# Status freshness
# ----------------------------------------------------------------------------

async def is_list_stale(ch: CHClient, ttl_sec: int) -> bool:
    """True if we should re-pull the full proposal list right now.

    Triggers a refresh when:
      • the table is empty;
      • the freshest row is older than ttl_sec; OR
      • we don't yet have enough closed proposals to fill a typical UI page
        (background poller only refreshes active ones — first-time visit
        for the All / Passed tabs would otherwise show nothing).
    """
    row = await ch.query_one(
        "SELECT count() AS n, "
        "dateDiff('second', max(fetched_at), now64(3)) AS age "
        "FROM gonka_vote.gov_proposals"
    )
    if not row or (row.get("n") or 0) == 0:
        return True
    if int(row["n"]) < 5:
        return True
    age = row.get("age")
    if age is None:
        return True
    return int(age) > ttl_sec


async def is_detail_stale(ch: CHClient, proposal_id: int, ttl_sec: int) -> bool:
    age = await ch.query_scalar(
        "SELECT dateDiff('second', fetched_at, now64(3)) "
        "FROM gonka_vote.gov_proposals FINAL WHERE proposal_id = {pid:UInt32}",
        {"pid": proposal_id},
    )
    if age is None:
        return True
    return int(age) > ttl_sec


# ----------------------------------------------------------------------------
# Proposal upsert (with translation diff detection)
# ----------------------------------------------------------------------------

async def upsert_proposal(ch: CHClient, raw: dict[str, Any]) -> None:
    """Insert/update one proposal row.

    If `title`, `summary` or `failed_reason` differ from what we already had,
    we wipe the corresponding *_t entry and enqueue a fresh detect job.
    """
    pid: int = int(raw["proposal_id"])
    new_title = str(raw.get("title") or "")
    new_summary = str(raw.get("summary") or "")
    new_failed = str(raw.get("failed_reason") or "")
    status_short = normalize_status(str(raw.get("status") or ""))

    existing = await ch.query_one(
        """
        SELECT title, summary, failed_reason, source_lang, status,
               title_t, summary_t, failed_reason_t,
               messages       AS existing_messages,
               metadata       AS existing_metadata
        FROM gonka_vote.gov_proposals FINAL
        WHERE proposal_id = {pid:UInt32}
        """,
        {"pid": pid},
    )

    text_changed = (
        existing is None
        or existing.get("title") != new_title
        or existing.get("summary") != new_summary
        or existing.get("failed_reason") != new_failed
    )

    # source_lang is preserved across re-INSERTs (translator sets it via
    # ALTER UPDATE — one-shot, not racy). Translations themselves live in
    # gov_proposal_translations, so we never copy *_t here and the poller
    # cannot race with the translator on translation content.
    source_lang = "" if not existing or text_changed else (existing.get("source_lang") or "")

    now = datetime.now(timezone.utc)
    # messages / metadata are stored as JSON-strings — the tracker API
    # returns them already decoded (list / dict respectively), but storing
    # them as strings keeps the schema flexible and lets the router pass
    # them straight to the JSON tab without re-serialising.
    #
    # IMPORTANT: list_proposals returns a *summary* — no `messages` and no
    # `metadata`. Anyone upserting from that path (the list refresh, a
    # stale poll, etc.) would otherwise blank those fields on every call.
    # If `raw` doesn't carry them but the cached row already does, keep
    # the cached values. Only get_proposal (detail) ever supplies them.
    def _stringify(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        import json as _json
        return _json.dumps(value, ensure_ascii=False)

    messages_str = _stringify(raw.get("messages"))
    if not messages_str and existing:
        messages_str = str(existing.get("existing_messages") or "")
    metadata_str = _stringify(raw.get("metadata"))
    if not metadata_str and existing:
        metadata_str = str(existing.get("existing_metadata") or "")
    await ch.insert(
        "gov_proposals",
        ["proposal_id", "title", "summary", "metadata_url", "proposer", "status",
         "expedited", "submit_time", "voting_start_time", "voting_end_time",
         "deposit_end_time", "yes_count", "no_count", "abstain_count", "veto_count",
         "total_deposit_ngonka", "voted_count", "depositor_count",
         "total_voters_at_end", "total_bonded_at_end", "epoch_at_submit",
         "failed_reason", "msg_types", "messages", "metadata",
         "source_lang", "title_t", "summary_t",
         "failed_reason_t", "fetched_at", "updated_at"],
        [[
            pid,
            new_title,
            new_summary,
            # metadata_url is a separate field on the tracker payload — the
            # GitHub PR URL the proposer linked. It's NOT the same as the
            # `metadata` markdown content we cache in gov_metadata.
            str(raw.get("metadata_url") or ""),
            str(raw.get("proposer") or ""),
            status_short,
            1 if raw.get("expedited") else 0,
            _parse_dt(raw.get("submit_time")),
            _parse_dt(raw.get("voting_start_time")),
            _parse_dt(raw.get("voting_end_time")),
            _parse_dt(raw.get("deposit_end_time")),
            str(raw.get("yes_count") or 0),
            str(raw.get("no_count") or 0),
            str(raw.get("abstain_count") or 0),
            str(raw.get("veto_count") or 0),
            str(raw.get("total_deposit_ngonka") or 0),
            int(raw.get("voted_count") or 0),
            int(raw.get("depositor_count") or 0),
            int(raw.get("total_voters_at_end") or 0),
            str(raw.get("total_bonded_at_end") or 0),
            int(raw["epoch_at_submit"]) if raw.get("epoch_at_submit") is not None else None,
            new_failed,
            list(raw.get("msg_types") or []),
            messages_str,
            metadata_str,
            source_lang,
            "{}",    # title_t — legacy column, unused; gov_proposal_translations is canonical
            "{}",    # summary_t — same
            "{}",    # failed_reason_t — same
            now,
            now,
        ]],
    )

    uid = proposal_uuid(pid, "gov_proposal")
    # Enqueue on text change, OR self-heal: an untranslated proposal
    # (source_lang still empty) whose initial detect job was lost — e.g.
    # the first enqueue threw — never re-triggers on its own because its
    # text won't change again. Re-enqueue if no job row exists at all.
    needs_enqueue = text_changed
    if not needs_enqueue and not source_lang:
        try:
            needs_enqueue = not await has_any_job(ch, uid)
        except Exception as e:
            logger.warning("has_any_job(gov_proposal %s) check failed: %s", pid, e)
    if needs_enqueue:
        try:
            await enqueue_detect(ch, "gov_proposal", uid)
        except Exception as e:
            logger.warning("enqueue_detect(gov_proposal %s) failed: %s", pid, e)

    # First time the proposal is observed in 'voting' status → fan out a
    # Telegram notification. Three cases must all fire exactly once:
    #   1. Brand-new row, already in voting (rare — no deposit phase).
    #   2. Brand-new row, in deposit/passed/whatever else now (no notify).
    #   3. Existing row was in deposit (or any non-voting state) and just
    #      transitioned to voting — this is the COMMON path on Gonka, where
    #      proposals first appear in the deposit list and only later cross
    #      into voting once min_deposit is met.
    # Dedup is enforced downstream by the notification_jobs merge key
    # (recipient_email, kind, source_comment_id) — the source_comment_id is
    # derived from proposal_id, so two firings collapse to one row.
    just_entered_voting = (
        status_short == "voting"
        and (existing is None or existing.get("status") != "voting")
    )
    if just_entered_voting:
        await enqueue_new_proposal_notifications(ch, pid)


# ----------------------------------------------------------------------------
# Votes / deposits — full replace per proposal
# ----------------------------------------------------------------------------

async def upsert_votes(ch: CHClient, proposal_id: int, votes: list[dict[str, Any]]) -> None:
    if not votes:
        return
    # Wipe stale rows for this proposal before inserting the fresh snapshot.
    # The PK is (proposal_id, voter, option), so a voter who switched options
    # (e.g. ABSTAIN → YES) or shrank from a 4-row MsgVoteWeighted to a
    # single-option MsgVote would otherwise leave orphan rows that
    # ReplacingMergeTree can't dedupe. mutations_sync=2 makes the DELETE
    # complete before we INSERT, avoiding a race that could swallow new rows.
    await ch.command(
        "ALTER TABLE gov_votes DELETE WHERE proposal_id = {pid:UInt64} "
        "SETTINGS mutations_sync = 2",
        parameters={"pid": proposal_id},
    )
    now = datetime.now(timezone.utc)
    rows = [
        [
            proposal_id,
            str(v.get("voter") or ""),
            str(v.get("option") or ""),
            float(v.get("weight") or 0.0),
            str(v.get("voting_power") or 0),
            int(v.get("voted_height") or 0),
            _parse_dt(v.get("voted_at")),
            str(v.get("tx_hash") or ""),
            now,
            now,
        ]
        for v in votes
    ]
    await ch.insert(
        "gov_votes",
        ["proposal_id", "voter", "option", "weight", "voting_power",
         "voted_height", "voted_at", "tx_hash", "fetched_at", "updated_at"],
        rows,
    )


async def upsert_deposits(ch: CHClient, proposal_id: int, deposits: list[dict[str, Any]]) -> None:
    if not deposits:
        return
    now = datetime.now(timezone.utc)
    epoch = datetime.fromtimestamp(0, tz=timezone.utc)
    rows = [
        [
            proposal_id,
            str(d.get("depositor") or ""),
            _parse_dt(d.get("deposited_at")) or epoch,
            str(d.get("amount_ngonka") or 0),
            str(d.get("tx_hash") or ""),
            now,
            now,
        ]
        for d in deposits
    ]
    await ch.insert(
        "gov_deposits",
        ["proposal_id", "depositor", "deposited_at", "amount", "tx_hash",
         "fetched_at", "updated_at"],
        rows,
    )


# ----------------------------------------------------------------------------
# Metadata (markdown from GitHub)
# ----------------------------------------------------------------------------

async def upsert_metadata(
    ch: CHClient, proposal_id: int, md: dict[str, Any],
) -> None:
    """Persist the GitHub-fetched markdown. If markdown text changed, wipe
    markdown_t and enqueue a translation job."""
    new_md = str(md.get("markdown") or "")
    new_url = str(md.get("source_url") or "")
    existing = await ch.query_one(
        "SELECT markdown, markdown_t FROM gonka_vote.gov_metadata FINAL "
        "WHERE proposal_id = {pid:UInt32}",
        {"pid": proposal_id},
    )
    text_changed = existing is None or existing.get("markdown") != new_md
    markdown_t = "{}" if text_changed else (existing.get("markdown_t") or "{}")
    now = datetime.now(timezone.utc)
    await ch.insert(
        "gov_metadata",
        ["proposal_id", "markdown", "source_url", "markdown_t",
         "fetched_at", "updated_at"],
        [[proposal_id, new_md, new_url, markdown_t, now, now]],
    )
    if text_changed and new_md:
        try:
            await enqueue_detect(ch, "gov_metadata", proposal_uuid(proposal_id, "gov_metadata"))
        except Exception as e:
            logger.warning("enqueue_detect(gov_metadata %s) failed: %s", proposal_id, e)


async def upsert_params(ch: CHClient, params: dict[str, Any]) -> None:
    now = datetime.now(timezone.utc)
    await ch.insert(
        "gov_params",
        ["pk", "payload_json", "fetched_at", "updated_at"],
        [[1, json.dumps(params, ensure_ascii=False), now, now]],
    )


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _parse_dt(v: Any) -> Optional[datetime]:
    """ISO-string → tz-aware datetime, or None."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None
