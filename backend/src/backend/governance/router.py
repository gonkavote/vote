"""HTTP API: /api/governance/*.

Reads from our gov_* cache. If a record is stale (or missing), tries a
lazy refresh against tracker — but never blocks the response on it
failing: stale-or-missing data is still served.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Optional
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from backend.auth import _ensure_ch, current_user, current_user_optional  # type: ignore
from backend.governance import cache, client
from backend.governance.models import (
    GovDeposit,
    GovMetadata,
    GovParams,
    GovProposalDetail,
    GovProposalsPage,
    GovProposalSummary,
    GovVote,
    normalize_status,
)
from backend.models import CommentCreate, CommentOut
from backend.router import _pick_translation  # reuse the same logic as tenders
from backend.settings import settings
from backend.translation_queue import enqueue_detect
from backend.notifications import enqueue_comment_notifications

logger = logging.getLogger(__name__)

gov_router = APIRouter(prefix="/api/governance")

# Stale-while-revalidate: when an endpoint sees a cache miss, it returns the
# stale rows immediately and kicks off a refresh in the background. This dict
# de-duplicates concurrent in-flight refreshes by key (e.g. "list", "detail:42",
# "metadata:42") so a sudden burst of user requests doesn't fan out into N
# parallel hits to the upstream tracker.
_inflight: dict[str, asyncio.Task[Any]] = {}


def _kick_background(key: str, coro_factory) -> None:
    """Schedule `coro_factory()` if no in-flight task for `key` exists.
    Pass a zero-arg lambda so we only build the coroutine when we'll await it."""
    existing = _inflight.get(key)
    if existing and not existing.done():
        return
    task = asyncio.create_task(coro_factory(), name=f"gov-refresh:{key}")

    def _cleanup(t: asyncio.Task[Any]) -> None:
        _inflight.pop(key, None)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.warning("background refresh %s failed: %s", key, exc)

    task.add_done_callback(_cleanup)
    _inflight[key] = task


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _row_to_proposal_summary(r: dict[str, Any], target_lang: str) -> GovProposalSummary:
    # title_t/summary_t come from a LEFT JOIN on gov_proposal_translations now —
    # plain strings, no JSON parsing needed.
    title_t = r.get("title_t") or ""
    summary_t = r.get("summary_t") or ""
    source_lang = r.get("source_lang") or ""
    job_status = r.get("job_status") or ""
    title_show, t_is_t, t_status = _pick_translation(
        r["title"], title_t, source_lang, target_lang, job_status,
    )
    summary_show, s_is_t, _ = _pick_translation(
        r.get("summary") or "", summary_t, source_lang, target_lang, job_status,
    )
    is_translated = t_is_t or s_is_t
    return GovProposalSummary(
        proposal_id=int(r["proposal_id"]),
        title=title_show,
        summary=summary_show,
        status=r["status"],
        expedited=bool(int(r.get("expedited") or 0)),
        submit_time=r["submit_time"],
        voting_start_time=r.get("voting_start_time"),
        voting_end_time=r.get("voting_end_time"),
        deposit_end_time=r.get("deposit_end_time"),
        yes_count=str(r.get("yes_count") or 0),
        no_count=str(r.get("no_count") or 0),
        abstain_count=str(r.get("abstain_count") or 0),
        veto_count=str(r.get("veto_count") or 0),
        total_deposit_ngonka=str(r.get("total_deposit_ngonka") or 0),
        voted_count=int(r.get("voted_count") or 0),
        depositor_count=int(r.get("depositor_count") or 0),
        total_voters_at_end=int(r.get("total_voters_at_end") or 0),
        total_bonded_at_end=str(r.get("total_bonded_at_end") or 0),
        epoch_at_submit=r.get("epoch_at_submit"),
        msg_types=list(r.get("msg_types") or []),
        source_lang=source_lang,
        is_translated=is_translated,
        original_title=r["title"] if is_translated else None,
        original_summary=(r.get("summary") or "") if is_translated else None,
        translation_status=t_status,
    )


def _read_t(raw: Any, lang: str) -> str:
    """Pull the lang-specific value from a JSON-as-String column."""
    if not raw or not lang:
        return ""
    try:
        obj = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(obj, dict):
            return str(obj.get(lang) or "")
    except (json.JSONDecodeError, TypeError):
        pass
    return ""


# ----------------------------------------------------------------------------
# /governance/proposals — list
# ----------------------------------------------------------------------------

@gov_router.get("/proposals", response_model=GovProposalsPage)
async def list_proposals(
    status: Optional[str] = Query(None, description="voting | deposit | passed | rejected | failed | all"),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    lang: Optional[str] = None,
) -> GovProposalsPage:
    ch = _ensure_ch()
    target_lang = (lang or "").strip().lower()

    # Stale-while-revalidate: serve the cached list immediately and trigger a
    # background refresh if it's older than the TTL. The user gets the page
    # without waiting on tracker; the next refetchInterval tick on the SPA
    # picks up the new rows.
    try:
        stale = await cache.is_list_stale(ch, settings.governance_list_ttl)
        empty = (await ch.query_scalar(
            "SELECT count() FROM gonka_vote.gov_proposals"
        ) or 0) == 0
        if empty:
            # First hit after deploy — block until we have data, otherwise we
            # would render an empty page.
            try:
                await _refresh_full_list(ch)
            except httpx.HTTPError as e:
                logger.warning("governance initial list fetch failed: %s", e)
        elif stale:
            _kick_background("list", lambda: _refresh_full_list(ch))
    except Exception as e:
        logger.warning("governance lazy list refresh kick failed: %s", e)

    where_parts: list[str] = []
    params: dict[str, Any] = {"lang": target_lang}
    if status and status != "all":
        where_parts.append("status = {status:String}")
        params["status"] = normalize_status(status)
    if search:
        q = search.strip()
        params["q"] = q
        # Match either the title (substring, case-insensitive) or any voter
        # address that starts with the query (covers full + partial bech32).
        where_parts.append(
            "(positionCaseInsensitive(title, {q:String}) > 0 "
            " OR proposal_id IN ("
            "    SELECT proposal_id FROM gonka_vote.gov_votes "
            "    WHERE startsWith(voter, {q:String})"
            " ))"
        )
    where_sql = " AND ".join(where_parts) if where_parts else "1"

    total = await ch.query_scalar(
        f"SELECT count() FROM gonka_vote.gov_proposals FINAL WHERE {where_sql}",
        params,
    )
    total = int(total or 0)

    offset = (page - 1) * page_size
    params["limit"] = page_size
    params["offset"] = offset
    sql = (
        "SELECT "
        "p.proposal_id AS proposal_id, p.title AS title, p.summary AS summary, "
        "p.status AS status, p.expedited AS expedited, p.submit_time AS submit_time, "
        "p.voting_start_time AS voting_start_time, p.voting_end_time AS voting_end_time, "
        "p.deposit_end_time AS deposit_end_time, "
        "toString(p.yes_count) AS yes_count, toString(p.no_count) AS no_count, "
        "toString(p.abstain_count) AS abstain_count, toString(p.veto_count) AS veto_count, "
        "toString(p.total_deposit_ngonka) AS total_deposit_ngonka, "
        "p.voted_count AS voted_count, p.depositor_count AS depositor_count, "
        "p.total_voters_at_end AS total_voters_at_end, "
        "toString(p.total_bonded_at_end) AS total_bonded_at_end, "
        "p.epoch_at_submit AS epoch_at_submit, p.msg_types AS msg_types, "
        "p.source_lang AS source_lang, pt.title AS title_t, pt.summary AS summary_t, "
        "COALESCE(tj.status, '') AS job_status "
        "FROM gonka_vote.gov_proposals AS p FINAL "
        "LEFT JOIN gonka_vote.translation_jobs AS tj FINAL "
        "  ON tj.kind = 'gov_proposal' "
        " AND tj.entity_id = toUUID(concat('00000000-0000-0000-0000-', "
        "      lower(leftPad(hex(p.proposal_id), 12, '0')))) "
        " AND tj.target_lang = {lang:String} "
        "LEFT JOIN gonka_vote.gov_proposal_translations AS pt FINAL "
        "  ON pt.proposal_id = p.proposal_id AND pt.target_lang = {lang:String} "
        f"WHERE {where_sql} "
        "ORDER BY p.proposal_id DESC "
        "LIMIT {limit:UInt32} OFFSET {offset:UInt32}"
    )
    rows = await ch.query_rows(sql, params)

    return GovProposalsPage(
        proposals=[_row_to_proposal_summary(r, target_lang) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


async def _refresh_full_list(ch) -> None:
    """Pull ALL statuses (not just active) from tracker and upsert into cache.
    Used when our list cache is empty/very stale."""
    page = 1
    while True:
        body = await client.list_proposals(page=page, page_size=100)
        proposals = body.get("proposals") or []
        for raw in proposals:
            try:
                await cache.upsert_proposal(ch, raw)
            except Exception as e:
                logger.warning("upsert(%s) during full refresh: %s",
                               raw.get("proposal_id"), e)
        if len(proposals) < 100:
            break
        page += 1
        if page > 50:  # safety stop
            break


# ----------------------------------------------------------------------------
# /governance/proposals/{id} — detail
# ----------------------------------------------------------------------------

@gov_router.get("/proposals/{proposal_id}", response_model=GovProposalDetail)
async def get_proposal(proposal_id: int, lang: Optional[str] = None) -> GovProposalDetail:
    ch = _ensure_ch()
    target_lang = (lang or "").strip().lower()

    # Stale-while-revalidate, but with a hard rule:
    # closed proposals (passed/rejected/failed) are IMMUTABLE on-chain, so
    # there's nothing to revalidate. Hammering the tracker every minute
    # for every detail view of a closed proposal was both wasteful AND
    # risky — any transient empty/half-baked tracker response would blow
    # away the cached messages/metadata for that row.
    try:
        existing = await ch.query_one(
            "SELECT status FROM gonka_vote.gov_proposals FINAL "
            "WHERE proposal_id = {pid:UInt32}",
            {"pid": proposal_id},
        )
        if not existing:
            try:
                await _refresh_detail(ch, proposal_id)
            except httpx.HTTPError as e:
                logger.warning("governance initial detail fetch %s failed: %s", proposal_id, e)
        else:
            status = (existing.get("status") or "").lower()
            # Only active proposals can change; refresh those in the background
            # if they're stale. Closed proposals are served straight from cache.
            if status in ("voting", "deposit") and await cache.is_detail_stale(
                ch, proposal_id, settings.governance_detail_ttl,
            ):
                _kick_background(
                    f"detail:{proposal_id}",
                    lambda: _refresh_detail(ch, proposal_id),
                )
    except Exception as e:
        logger.warning("governance lazy detail refresh kick %s failed: %s", proposal_id, e)

    row = await ch.query_one(
        """
        SELECT
            p.proposal_id            AS proposal_id,
            p.title                  AS title,
            p.summary                AS summary,
            p.metadata_url           AS metadata_url,
            p.proposer               AS proposer,
            p.status                 AS status,
            p.expedited              AS expedited,
            p.submit_time            AS submit_time,
            p.voting_start_time      AS voting_start_time,
            p.voting_end_time        AS voting_end_time,
            p.deposit_end_time       AS deposit_end_time,
            toString(p.yes_count)            AS yes_count,
            toString(p.no_count)             AS no_count,
            toString(p.abstain_count)        AS abstain_count,
            toString(p.veto_count)           AS veto_count,
            toString(p.total_deposit_ngonka) AS total_deposit_ngonka,
            p.voted_count            AS voted_count,
            p.depositor_count        AS depositor_count,
            p.total_voters_at_end    AS total_voters_at_end,
            toString(p.total_bonded_at_end)  AS total_bonded_at_end,
            p.epoch_at_submit        AS epoch_at_submit,
            p.failed_reason          AS failed_reason,
            p.msg_types              AS msg_types,
            p.messages               AS messages,
            p.metadata               AS metadata,
            p.source_lang            AS source_lang,
            pt.title                 AS title_t,
            pt.summary               AS summary_t,
            pt.failed_reason         AS failed_reason_t,
            COALESCE(tj.status, '')  AS job_status
        FROM gonka_vote.gov_proposals AS p FINAL
        LEFT JOIN gonka_vote.translation_jobs AS tj FINAL
                  ON tj.kind = 'gov_proposal'
                 AND tj.entity_id = toUUID(concat('00000000-0000-0000-0000-', lower(leftPad(hex(p.proposal_id), 12, '0'))))
                 AND tj.target_lang = {lang:String}
        LEFT JOIN gonka_vote.gov_proposal_translations AS pt FINAL
                  ON pt.proposal_id = p.proposal_id AND pt.target_lang = {lang:String}
        WHERE p.proposal_id = {pid:UInt32}
        """,
        {"pid": proposal_id, "lang": target_lang},
    )
    if not row:
        raise HTTPException(404, "proposal not found")

    summary = _row_to_proposal_summary(row, target_lang)
    failed_t = row.get("failed_reason_t") or ""
    failed_show, failed_is_t, _ = _pick_translation(
        row.get("failed_reason") or "", failed_t, summary.source_lang, target_lang,
        row.get("job_status") or "",
    )
    is_translated = summary.is_translated or failed_is_t
    # messages was stored as a JSON-string blob; decode it back to a list
    # so the response is identical in shape to the upstream tracker API.
    messages_raw = row.get("messages") or ""
    try:
        import json as _json
        messages = _json.loads(messages_raw) if messages_raw else []
    except (ValueError, TypeError):
        messages = []
    if not isinstance(messages, list):
        messages = []
    return GovProposalDetail(
        **summary.model_dump(),
        metadata_url=row.get("metadata_url") or "",
        proposer=row.get("proposer") or "",
        failed_reason=failed_show,
        original_failed_reason=(row.get("failed_reason") or "") if failed_is_t else None,
        messages=messages,
        metadata=row.get("metadata") or "",
    ).model_copy(update={"is_translated": is_translated})


async def _refresh_detail(ch, proposal_id: int) -> None:
    raw = await client.get_proposal(proposal_id)
    # Same belt-and-braces guard as in the poller: if the tracker glitches
    # and returns a proposal with empty messages AND metadata when we
    # already have them cached, don't blank the row out.
    if not raw.get("messages") and not raw.get("metadata"):
        try:
            existing = await ch.query_one(
                "SELECT length(messages) AS m, length(metadata) AS d "
                "FROM gonka_vote.gov_proposals FINAL "
                "WHERE proposal_id = {pid:UInt32}",
                {"pid": proposal_id},
            )
            if existing and (existing.get("m", 0) > 0 or existing.get("d", 0) > 0):
                logger.info(
                    "tracker returned empty messages/metadata for proposal %s "
                    "but cache already has them — skipping detail upsert",
                    proposal_id,
                )
            else:
                await cache.upsert_proposal(ch, raw)
        except Exception as e:
            logger.warning("pre-upsert check for %s failed: %s", proposal_id, e)
    else:
        await cache.upsert_proposal(ch, raw)
    try:
        votes = await client.list_votes(proposal_id)
        await cache.upsert_votes(ch, proposal_id, votes)
    except httpx.HTTPError:
        pass
    try:
        deposits = await client.list_deposits(proposal_id)
        await cache.upsert_deposits(ch, proposal_id, deposits)
    except httpx.HTTPError:
        pass


# ----------------------------------------------------------------------------
# /governance/proposals/{id}/votes
# ----------------------------------------------------------------------------

@gov_router.get("/proposals/{proposal_id}/votes", response_model=list[GovVote])
async def list_votes(
    proposal_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(500, ge=1, le=1000),
) -> list[GovVote]:
    ch = _ensure_ch()
    offset = (page - 1) * page_size
    rows = await ch.query_rows(
        """
        SELECT voter, option, weight, voting_power, voted_height, voted_at, tx_hash
        FROM gonka_vote.gov_votes FINAL
        WHERE proposal_id = {pid:UInt32}
        ORDER BY voted_at DESC, voter ASC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        """,
        {"pid": proposal_id, "limit": page_size, "offset": offset},
    )
    return [GovVote(
        voter=r["voter"],
        option=r["option"],
        weight=float(r.get("weight") or 0),
        voting_power=str(r.get("voting_power") or 0),
        voted_at=r.get("voted_at"),
        voted_height=int(r.get("voted_height") or 0),
        tx_hash=r.get("tx_hash") or "",
    ) for r in rows]


@gov_router.get("/proposals/{proposal_id}/deposits", response_model=list[GovDeposit])
async def list_deposits(proposal_id: int) -> list[GovDeposit]:
    ch = _ensure_ch()
    rows = await ch.query_rows(
        """
        SELECT depositor, amount, deposited_at, tx_hash
        FROM gonka_vote.gov_deposits FINAL
        WHERE proposal_id = {pid:UInt32}
        ORDER BY deposited_at DESC, depositor ASC
        """,
        {"pid": proposal_id},
    )
    return [GovDeposit(
        depositor=r["depositor"],
        amount_ngonka=str(r.get("amount") or 0),
        deposited_at=r.get("deposited_at"),
        tx_hash=r.get("tx_hash") or "",
    ) for r in rows]


# ----------------------------------------------------------------------------
# /governance/proposals/{id}/metadata — GitHub README
# ----------------------------------------------------------------------------

@gov_router.get("/proposals/{proposal_id}/metadata", response_model=GovMetadata)
async def get_metadata(proposal_id: int, lang: Optional[str] = None) -> GovMetadata:
    ch = _ensure_ch()
    target_lang = (lang or "").strip().lower()

    # Stale-while-revalidate: if we have anything cached for this proposal,
    # serve it instantly and refresh in the background. On the very first
    # request we have to block, otherwise the page renders 'no metadata'.
    cached = await ch.query_scalar(
        "SELECT 1 FROM gonka_vote.gov_metadata FINAL WHERE proposal_id = {pid:UInt32}",
        {"pid": proposal_id},
    )

    async def _refresh() -> None:
        try:
            md = await client.get_metadata(proposal_id)
            if md is not None:
                await cache.upsert_metadata(ch, proposal_id, md)
        except httpx.HTTPError as e:
            logger.debug("governance metadata refresh %s: %s", proposal_id, e)

    if not cached:
        await _refresh()
    else:
        _kick_background(f"metadata:{proposal_id}", _refresh)

    row = await ch.query_one(
        """
        SELECT
            m.proposal_id            AS proposal_id,
            m.markdown               AS markdown,
            m.source_url             AS source_url,
            m.markdown_t             AS markdown_t,
            m.fetched_at             AS fetched_at,
            COALESCE(p.source_lang, '') AS proposal_source_lang,
            COALESCE(tj.status, '')  AS job_status
        FROM gonka_vote.gov_metadata AS m FINAL
        LEFT JOIN gonka_vote.gov_proposals AS p FINAL
                  ON p.proposal_id = m.proposal_id
        LEFT JOIN gonka_vote.translation_jobs AS tj FINAL
                  ON tj.kind = 'gov_metadata'
                 AND tj.entity_id = toUUID(concat('00000000-0000-0000-0000-', lower(leftPad(hex(m.proposal_id), 12, '0'))))
                 AND tj.target_lang = {lang:String}
        WHERE m.proposal_id = {pid:UInt32}
        """,
        {"pid": proposal_id, "lang": target_lang},
    )
    if not row:
        raise HTTPException(404, "no metadata for this proposal")

    md_text = row.get("markdown") or ""
    md_t = _read_t(row.get("markdown_t"), target_lang)
    # The metadata language follows the proposal's source_lang (the README is
    # written in the same language as the proposal text).
    source_lang = row.get("proposal_source_lang") or ""
    job_status = row.get("job_status") or ""
    show, is_translated, status = _pick_translation(
        md_text, md_t, source_lang, target_lang, job_status,
    )
    return GovMetadata(
        proposal_id=int(row["proposal_id"]),
        markdown=show,
        source_url=row.get("source_url") or "",
        fetched_at=row.get("fetched_at"),
        is_translated=is_translated,
        original_markdown=md_text if is_translated else None,
        translation_status=status,
    )


@gov_router.get("/params", response_model=GovParams)
async def get_params() -> GovParams:
    ch = _ensure_ch()
    row = await ch.query_one(
        "SELECT payload_json, fetched_at FROM gonka_vote.gov_params FINAL WHERE pk = 1"
    )
    if not row:
        return GovParams()
    return GovParams(
        payload_json=row.get("payload_json") or "{}",
        fetched_at=row.get("fetched_at"),
    )


# ----------------------------------------------------------------------------
# Comments — proposal-scoped, share the comments table with tenders.
#
# We encode `proposal_id` into a fixed UUID so the existing comments schema
# (which keys by tender_id UUID) keeps working without a migration. The
# encoding is the same one used by translation_jobs for governance entities.
# ----------------------------------------------------------------------------

def _proposal_owner_uuid(proposal_id: int) -> str:
    return f"00000000-0000-0000-0000-{proposal_id:012x}"


@gov_router.get("/proposals/{proposal_id}/comments", response_model=list[CommentOut])
async def list_proposal_comments(
    proposal_id: int,
    request: Request,
    lang: Optional[str] = None,
) -> list[CommentOut]:
    ch = _ensure_ch()
    target_lang = (lang or "").strip().lower()
    me_record = await current_user_optional(request)
    me_uid = me_record["uid"] if me_record else ""
    owner = _proposal_owner_uuid(proposal_id)

    rows = await ch.query_rows(
        """
        SELECT
            c.id                                    AS id,
            c.parent_comment_id                     AS parent_comment_id,
            COALESCE(NULLIF(c.author_uid, ''), u.uid, '') AS author_uid,
            COALESCE(u.name, c.author_name)         AS author_name,
            u.image                                 AS author_image,
            c.body                                  AS body,
            c.source_lang                           AS source_lang,
            ct.body                                 AS body_t,
            c.created_at                            AS created_at,
            COALESCE(tj.status, '')                 AS job_status,
            countIf(r.reaction_type = 'like')       AS likes,
            countIf(r.reaction_type = 'dislike')    AS dislikes,
            anyIf(r.reaction_type,
                  r.reactor_uid = {me_uid:String} AND r.reaction_type != '') AS my_reaction
        FROM gonka_vote.comments AS c
        LEFT JOIN gonka_vote.users             AS u FINAL ON u.email = c.author_email
        LEFT JOIN gonka_vote.comment_reactions AS r FINAL ON r.comment_id = c.id
        LEFT JOIN gonka_vote.translation_jobs  AS tj FINAL
                  ON tj.kind = 'comment' AND tj.entity_id = c.id AND tj.target_lang = {lang:String}
        LEFT JOIN gonka_vote.comment_translations AS ct FINAL
                  ON ct.comment_id = c.id AND ct.target_lang = {lang:String}
        WHERE c.tender_id = {id:UUID} AND c.deleted_at IS NULL
        GROUP BY c.id, c.parent_comment_id, c.author_uid, c.author_name,
                 u.uid, u.name, u.image, c.body, c.source_lang, ct.body,
                 c.created_at, tj.status
        ORDER BY (toInt64(countIf(r.reaction_type = 'like'))
                  - toInt64(countIf(r.reaction_type = 'dislike'))) DESC,
                 c.created_at ASC
        """,
        {"id": owner, "me_uid": me_uid, "lang": target_lang},
    )
    out: list[CommentOut] = []
    for r in rows:
        source_lang = r.get("source_lang") or ""
        body_show, is_t, status = _pick_translation(
            r["body"], r.get("body_t") or "", source_lang, target_lang,
            r.get("job_status") or "",
        )
        out.append(CommentOut(
            id=r["id"],
            parent_comment_id=r.get("parent_comment_id"),
            author_uid=r["author_uid"] or "",
            author_name=r.get("author_name"),
            author_image=r.get("author_image"),
            body=body_show,
            created_at=r["created_at"],
            likes=int(r["likes"] or 0),
            dislikes=int(r["dislikes"] or 0),
            my_reaction=(r["my_reaction"] or None) or None,
            source_lang=source_lang,
            is_translated=is_t,
            original_body=r["body"] if is_t else None,
            translation_status=status,
        ))
    return out


@gov_router.post("/proposals/{proposal_id}/comments", status_code=201,
                 response_model=CommentOut)
async def add_proposal_comment(
    proposal_id: int,
    payload: CommentCreate,
    user: dict = Depends(current_user),
) -> CommentOut:
    ch = _ensure_ch()
    # Sanity: proposal must exist in our cache. If not, refuse — we don't
    # fetch from tracker on demand here (the user must have visited the
    # detail page first, which already triggers a lazy refresh).
    exists = await ch.query_scalar(
        "SELECT 1 FROM gonka_vote.gov_proposals FINAL "
        "WHERE proposal_id = {pid:UInt32}",
        {"pid": proposal_id},
    )
    if not exists:
        raise HTTPException(404, "proposal not found")

    owner = _proposal_owner_uuid(proposal_id)
    if payload.parent_comment_id is not None:
        parent_owner = await ch.query_scalar(
            "SELECT tender_id FROM gonka_vote.comments "
            "WHERE id = {pid:UUID} AND deleted_at IS NULL LIMIT 1",
            {"pid": str(payload.parent_comment_id)},
        )
        if parent_owner is None:
            raise HTTPException(404, "parent comment not found")
        if str(parent_owner) != owner:
            raise HTTPException(400, "parent comment belongs to a different proposal")

    cid = uuid4()
    now = datetime.now(timezone.utc)
    await ch.insert(
        "comments",
        ["id", "tender_id", "author_email", "author_name", "body", "created_at",
         "parent_comment_id", "author_uid", "source_lang"],
        [[cid, owner, user["email"], user.get("name"), payload.body, now,
          payload.parent_comment_id, user["uid"], ""]],
    )
    try:
        await enqueue_detect(ch, "comment", cid)
    except Exception as e:
        logger.warning("enqueue_detect(comment) failed for %s: %s", cid, e)
    await enqueue_comment_notifications(ch, cid)
    from backend.lang_detect import supported_languages
    return CommentOut(
        id=cid,
        parent_comment_id=payload.parent_comment_id,
        author_uid=user["uid"],
        author_name=user.get("name"),
        author_image=user.get("image"),
        body=payload.body,
        created_at=now,
        likes=0,
        dislikes=0,
        my_reaction=None,
        source_lang="",
        translation_status="pending" if len(supported_languages()) > 1 else "ready",
    )
