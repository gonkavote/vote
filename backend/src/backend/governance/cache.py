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
    # Only *active* proposals age: upsert_proposal skips writing rows whose
    # content is unchanged, so fetched_at on a settled proposal stops moving
    # by design. Measuring freshness across all rows would then read as
    # permanently stale and kick a full re-pull on every page view. Voting /
    # deposit proposals are the ones that can actually change, so their
    # freshness is what decides whether the list needs re-pulling; when there
    # are none, the cached list cannot go out of date on its own.
    row = await ch.query_one(
        "SELECT count() AS n, "
        "countIf(status IN ('voting', 'deposit')) AS active, "
        "maxIf(fetched_at, status IN ('voting', 'deposit')) AS active_fetched_at, "
        "dateDiff('second', "
        "         maxIf(fetched_at, status IN ('voting', 'deposit')), "
        "         now64(3)) AS active_age "
        "FROM gonka_vote.gov_proposals FINAL"
    )
    if not row or (row.get("n") or 0) == 0:
        return True
    if int(row["n"]) < 5:
        return True
    if (row.get("active") or 0) == 0:
        # Nothing can change until a new proposal appears; the poller picks
        # those up on its own tick without needing a list-wide refresh.
        return False
    age = row.get("active_age")
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

def _row_unchanged(
    existing: dict[str, Any],
    raw: dict[str, Any],
    status_short: str,
    messages_str: str,
    metadata_str: str,
) -> bool:
    """True when the incoming payload matches the cached row field-for-field.

    Only compares what upsert_proposal actually writes from `raw`. Columns the
    poller never sources from the tracker payload (source_lang, the legacy *_t
    columns) are owned by the translator and are copied forward unchanged, so
    they can't differ here. fetched_at/updated_at are excluded by design: they
    move every tick, which is precisely the write we're trying to avoid.
    """
    def _s(v: Any) -> str:
        return "" if v is None else str(v)

    def _i(v: Any) -> int:
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0

    if _s(existing.get("status")) != status_short:
        return False
    if _s(existing.get("metadata_url")) != _s(raw.get("metadata_url")):
        return False
    if _s(existing.get("proposer")) != _s(raw.get("proposer")):
        return False
    if _i(existing.get("expedited")) != (1 if raw.get("expedited") else 0):
        return False

    # Vote/deposit tallies are stored as strings (they exceed UInt64), so
    # compare them as strings the same way they're written.
    for col in ("yes_count", "no_count", "abstain_count", "veto_count",
                "total_deposit_ngonka", "total_bonded_at_end"):
        if _s(existing.get(col)) != _s(raw.get(col) or 0):
            return False

    for col in ("voted_count", "depositor_count", "total_voters_at_end"):
        if _i(existing.get(col)) != _i(raw.get(col)):
            return False

    if list(existing.get("msg_types") or []) != list(raw.get("msg_types") or []):
        return False

    # Timestamps: the cached column comes back as a datetime (naive UTC via
    # the driver) while `raw` carries an ISO string, so normalise both through
    # _parse_dt — it tags naive values as UTC — before comparing. A mismatch
    # in tz-awareness alone would otherwise make every row look changed and
    # silently defeat this whole check.
    for col in ("submit_time", "voting_start_time",
                "voting_end_time", "deposit_end_time"):
        if _parse_dt(existing.get(col)) != _parse_dt(raw.get(col)):
            return False

    raw_epoch = (
        int(raw["epoch_at_submit"])
        if raw.get("epoch_at_submit") is not None
        else None
    )
    if existing.get("epoch_at_submit") != raw_epoch:
        return False

    if _s(existing.get("existing_messages")) != messages_str:
        return False
    if _s(existing.get("existing_metadata")) != metadata_str:
        return False

    return True


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
               metadata       AS existing_metadata,
               metadata_url, proposer, expedited,
               yes_count, no_count, abstain_count, veto_count,
               total_deposit_ngonka, voted_count, depositor_count,
               total_voters_at_end, total_bonded_at_end, msg_types,
               submit_time, voting_start_time, voting_end_time,
               deposit_end_time, epoch_at_submit
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

    # Identical row in, identical row already stored → nothing to write.
    #
    # The poller ticks every 60 s over every active proposal and the lazy
    # list refresh re-pulls all of them, but a proposal's payload only moves
    # when someone votes/deposits or it changes status. Re-INSERTing an
    # unchanged row still spawns a part that ReplacingMergeTree has to merge
    # and drop — that churn produced ~9k parts/day for ~1.4 MiB of data and
    # dominated the disk-operations bill.
    #
    # fetched_at/updated_at are deliberately not part of the comparison: they
    # move every tick by construction, so treating them as a difference would
    # mean never skipping anything. Freezing them is safe — the only readers,
    # is_list_stale() and is_detail_stale(), use them to decide whether to
    # kick a *background* refresh; neither blocks a response or changes what
    # the user sees. is_list_stale() ignores rows whose content is settled
    # (see its query) so a frozen timestamp can't wedge it into refreshing on
    # every page view.
    if (
        existing is not None
        and not text_changed
        and _row_unchanged(existing, raw, status_short, messages_str, metadata_str)
    ):
        return

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

def _votes_fingerprint(rows: list[tuple[Any, ...]]) -> str:
    """Order-independent digest of a vote/deposit set, for change detection."""
    return json.dumps(sorted(str(r) for r in rows), ensure_ascii=False)


async def upsert_votes(ch: CHClient, proposal_id: int, votes: list[dict[str, Any]]) -> None:
    if not votes:
        return

    # The poller re-pulls every active proposal's votes each tick, but votes
    # only move when someone actually casts one. The DELETE below is a
    # mutation — the most expensive write ClickHouse has, rewriting whole
    # parts — so compare the incoming set against what's stored and bail out
    # when they match. Sorted digests make the comparison order-independent,
    # since the tracker API doesn't guarantee ordering.
    incoming = _votes_fingerprint([
        (
            str(v.get("voter") or ""),
            str(v.get("option") or ""),
            float(v.get("weight") or 0.0),
            str(v.get("voting_power") or 0),
            int(v.get("voted_height") or 0),
            str(v.get("tx_hash") or ""),
        )
        for v in votes
    ])
    try:
        stored_rows = await ch.query_rows(
            "SELECT voter, option, weight, voting_power, voted_height, tx_hash "
            "FROM gonka_vote.gov_votes FINAL WHERE proposal_id = {pid:UInt64}",
            {"pid": proposal_id},
        )
        stored = _votes_fingerprint([
            (
                str(r.get("voter") or ""),
                str(r.get("option") or ""),
                float(r.get("weight") or 0.0),
                str(r.get("voting_power") or 0),
                int(r.get("voted_height") or 0),
                str(r.get("tx_hash") or ""),
            )
            for r in stored_rows
        ])
        if stored_rows and stored == incoming:
            return
    except Exception as e:
        # Never let the comparison itself block the refresh — fall through and
        # write, which is the old behaviour.
        logger.warning("gov_votes change check for %s failed: %s", proposal_id, e)

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

    # Deposits are append-only in practice and re-pulled every tick; skip the
    # write when the stored set already matches (same reasoning as
    # upsert_votes, minus the mutation).
    incoming = _votes_fingerprint([
        (
            str(d.get("depositor") or ""),
            str(d.get("amount_ngonka") or 0),
            str(d.get("tx_hash") or ""),
        )
        for d in deposits
    ])
    try:
        stored_rows = await ch.query_rows(
            "SELECT depositor, amount, tx_hash FROM gonka_vote.gov_deposits FINAL "
            "WHERE proposal_id = {pid:UInt64}",
            {"pid": proposal_id},
        )
        stored = _votes_fingerprint([
            (
                str(r.get("depositor") or ""),
                str(r.get("amount") or 0),
                str(r.get("tx_hash") or ""),
            )
            for r in stored_rows
        ])
        if stored_rows and stored == incoming:
            return
    except Exception as e:
        logger.warning("gov_deposits change check for %s failed: %s", proposal_id, e)

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
        "SELECT markdown, markdown_t, source_url "
        "FROM gonka_vote.gov_metadata FINAL "
        "WHERE proposal_id = {pid:UInt32}",
        {"pid": proposal_id},
    )
    text_changed = existing is None or existing.get("markdown") != new_md
    markdown_t = "{}" if text_changed else (existing.get("markdown_t") or "{}")

    # Same story as upsert_proposal: the poller re-fetches GitHub markdown for
    # every active proposal on every tick, but the markdown itself only moves
    # when the proposer edits it — so an unchanged payload writes nothing.
    # source_url is compared too: it's written from `md` but isn't part of
    # text_changed, so a URL-only edit would otherwise be silently dropped.
    if (
        existing is not None
        and not text_changed
        and str(existing.get("source_url") or "") == new_url
    ):
        return

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
    """Persist the /governance/params snapshot (a single pk=1 row).

    Chain params move on governance upgrades — i.e. almost never — but the
    poller refreshes them every tick. Writing an identical row each time still
    spawns a part that ReplacingMergeTree has to merge and drop, so compare
    the serialised payload first and only write when it actually differs (or
    when the stored timestamp has gone stale enough to be worth refreshing;
    /governance/params surfaces fetched_at to the client).
    """
    payload = json.dumps(params, ensure_ascii=False)
    existing = await ch.query_one(
        "SELECT payload_json FROM gonka_vote.gov_params FINAL WHERE pk = 1"
    )
    if existing is not None and str(existing.get("payload_json") or "") == payload:
        return

    now = datetime.now(timezone.utc)
    await ch.insert(
        "gov_params",
        ["pk", "payload_json", "fetched_at", "updated_at"],
        [[1, payload, now, now]],
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
