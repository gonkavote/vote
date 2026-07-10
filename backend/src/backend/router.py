"""HTTP API for Gonka Vote.

Email is treated as private — it is exposed only via /api/me (the current
user's own session). All public-facing endpoints identify users by their
opaque `uid` instead.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

MIN_DEADLINE_DELTA = timedelta(days=7)
MAX_DEADLINE_DELTA = timedelta(days=30)
# Slack so the "1 week" preset on the frontend (which captures `now + 7d` at
# render time) doesn't 422 if the user spends a few minutes filling out the
# form before submitting. Without this, every "1 week" submission that takes
# >0s from preset-click to publish would be rejected.
DEADLINE_GRACE = timedelta(hours=2)
import secrets
import string
from typing import Optional
from uuid import UUID, uuid4

import httpx

# 6-char alphanumeric [a-z0-9] short id — 36^6 = ~2.2B combinations. Backend
# retries on collision. Old proposals keep short_id='' and remain UUID-only.
SHORT_ID_ALPHABET = string.ascii_lowercase + string.digits
SHORT_ID_LEN = 6


def _generate_short_id() -> str:
    return "".join(secrets.choice(SHORT_ID_ALPHABET) for _ in range(SHORT_ID_LEN))
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from backend.auth import current_admin, current_user, current_user_optional, _ensure_ch  # type: ignore
from backend.lang_detect import supported_languages
from backend.models import (
    CommentCreate,
    CommentOut,
    LinkedWallet,
    ProposalCreate,
    ProposalDetail,
    ProposalSummary,
    ReactionUpsert,
    UserOut,
    UserPublicProfile,
    UserUpdate,
)
from backend.settings import (
    effective_backend_chain_api_url,
    effective_backend_rpc_url,
    settings,
)
from backend.translation_queue import enqueue_detect
from backend.notifications import enqueue_comment_notifications

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# ----------------------------------------------------------------------------
# Health / config (no auth)
# ----------------------------------------------------------------------------

@router.get("/health")
async def health():
    ch = _ensure_ch()
    ok = await ch.ping()
    return {"ok": ok}


@router.get("/config")
async def public_config():
    # Bot id is the numeric prefix of the bot token (everything before
    # the ':'). Public — Telegram itself exposes it as `bot_id` in widget
    # URLs, no secret material here.
    tg_token = settings.telegram_bot_token
    tg_bot_id = 0
    if tg_token and ":" in tg_token:
        try:
            tg_bot_id = int(tg_token.split(":", 1)[0])
        except ValueError:
            tg_bot_id = 0

    return {
        "contract_address": settings.contract_address,
        "link_contract_address": settings.link_contract_address,
        "chain_id": settings.chain_id,
        "rpc_url": effective_backend_rpc_url(),
        # Same-origin HTTPS proxy. The browser would otherwise refuse to
        # talk to the plain-HTTP chain endpoint (mixed-content block).
        "rest_url": "/api/chain",
        # Empty when Telegram login is not configured — frontend hides
        # the widget in that case and only shows Google.
        "telegram_bot_username": settings.telegram_bot_username,
        "telegram_bot_id": tg_bot_id,
        # Tracker UI base ("" if not configured — frontend hides the
        # explorer links).
        "tracker_ui_url": settings.tracker_ui_url,
        # WalletConnect projectId for the in-app wallet flow ("" disables WC).
        "wc_project_id": settings.wc_project_id,
        # Public site URL — used by the SPA for canonical / OG / share links.
        "public_base_url": settings.public_base_url,
    }


# ----------------------------------------------------------------------------
# Chain REST proxy — strips the /api/chain prefix and forwards to the
# upstream node so the browser can stay on the same origin/scheme as the
# site (which is HTTPS via Cloudflare; the chain itself is HTTP-only).
# ----------------------------------------------------------------------------

_chain_client: Optional[httpx.AsyncClient] = None


def _chain_http() -> httpx.AsyncClient:
    global _chain_client
    if _chain_client is None:
        _chain_client = httpx.AsyncClient(
            base_url=effective_backend_chain_api_url(),
            timeout=httpx.Timeout(30.0),
        )
    return _chain_client


@router.api_route(
    "/chain/{path:path}",
    methods=["GET", "POST"],
    include_in_schema=False,
)
async def chain_proxy(path: str, request: Request) -> Response:
    upstream = _chain_http()
    qs = request.url.query
    target = f"/{path}" + (f"?{qs}" if qs else "")
    body = await request.body() if request.method == "POST" else None
    try:
        if request.method == "GET":
            r = await upstream.get(target)
        else:
            r = await upstream.post(
                target,
                content=body,
                headers={"Content-Type": request.headers.get("content-type", "application/json")},
            )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"chain upstream error: {e}")
    # Pass through the upstream response verbatim — keeps headers,
    # status codes and bodies intact.
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type"),
    )


# ----------------------------------------------------------------------------
# /me — private, includes email
# ----------------------------------------------------------------------------

@router.get("/me")
async def me(user: dict = Depends(current_user)) -> UserOut:
    return UserOut(**user)


@router.get("/me/optional")
async def me_optional(user: Optional[dict] = Depends(current_user_optional)) -> Optional[UserOut]:
    return UserOut(**user) if user else None


@router.patch("/me")
async def update_me(payload: UserUpdate, user: dict = Depends(current_user)) -> UserOut:
    ch = _ensure_ch()
    await ch.insert(
        "users",
        ["email", "name", "image", "wallet_address", "uid", "is_admin"],
        [[
            user["email"],
            user.get("name"),
            user.get("image"),
            payload.wallet_address,
            user["uid"],
            bool(user.get("is_admin")),
        ]],
    )
    refreshed = await ch.query_one(
        """
        SELECT uid, email, name, image, wallet_address, is_admin
        FROM gonka_vote.users FINAL
        WHERE email = {email:String}
        """,
        {"email": user["email"]},
    )
    return UserOut(**refreshed)


# ----------------------------------------------------------------------------
# Proposals
# ----------------------------------------------------------------------------
#
# Every endpoint below is registered under BOTH /proposal and /tenders paths
# so that external integrations that still hit /api/tenders/* keep working.
# The legacy /tenders alias is hidden from OpenAPI docs.
#
# On-chain wire format still uses `tender_id` for votes — this backend does
# not touch that; the smart-contract-facing code lives in the indexer.

# Aggregate reactions (like/dislike counts + weighted sums via wallet_links)
# per-proposal for the requested user. Weight = sum(balance_ngonka) across all
# active (unlinked_at IS NULL) wallets of the reactor. Users without wallets
# still count in `*_count` but contribute 0 weight.
_REACTIONS_CTE = """
    proposal_reactions_agg AS (
        WITH uid_weights AS (
            SELECT account_uid, sum(balance_ngonka) AS weight
            FROM gonka_vote.wallet_links FINAL
            WHERE unlinked_at IS NULL
            GROUP BY account_uid
        )
        SELECT
            r.proposal_id                                              AS proposal_id,
            countIf(r.reaction_type = 'like')                          AS likes_count,
            countIf(r.reaction_type = 'dislike')                       AS dislikes_count,
            toString(sumIf(COALESCE(w.weight, toUInt128(0)),
                           r.reaction_type = 'like'))                  AS likes_weight,
            toString(sumIf(COALESCE(w.weight, toUInt128(0)),
                           r.reaction_type = 'dislike'))               AS dislikes_weight,
            anyIf(r.reaction_type,
                  r.reactor_uid = {me_uid:String} AND r.reaction_type != '') AS my_reaction
        FROM gonka_vote.proposal_reactions AS r FINAL
        LEFT JOIN uid_weights AS w ON w.account_uid = r.reactor_uid
        WHERE r.reaction_type != ''
        GROUP BY r.proposal_id
    )
"""


@router.get("/proposal")
@router.get("/tenders", include_in_schema=False)
async def list_proposals(
    request: Request,
    lang: Optional[str] = None,
) -> list[ProposalSummary]:
    ch = _ensure_ch()
    target_lang = (lang or "").strip().lower()
    me_record = await current_user_optional(request)
    me_uid = me_record["uid"] if me_record else ""
    rows = await ch.query_rows(
        f"""
        WITH
        {_REACTIONS_CTE.strip().rstrip(',')},
        proposal_jobs AS (
            SELECT entity_id, status
            FROM gonka_vote.translation_jobs FINAL
            WHERE kind = 'proposal' AND target_lang = {{lang:String}}
        ),
        comment_counts AS (
            SELECT entity_id, count() AS cnt
            FROM gonka_vote.comments
            WHERE deleted_at IS NULL
            GROUP BY entity_id
        )
        SELECT
            t.id            AS id,
            t.short_id      AS short_id,
            t.title         AS title,
            t.summary       AS summary,
            t.source_lang   AS source_lang,
            ttx.title       AS title_t,
            ttx.summary     AS summary_t,
            COALESCE(NULLIF(t.creator_uid, ''), u.uid, '')  AS creator_uid,
            u.name                                          AS creator_name,
            u.image                                         AS creator_image,
            t.status        AS status,
            t.created_at    AS created_at,
            t.closes_at     AS closes_at,
            toUInt64(t.requested_amount_usdt) AS requested_amount_usdt,
            toUInt64(t.requested_amount_gnk)  AS requested_amount_gnk,
            COALESCE(pr.likes_count, 0)         AS likes_count,
            COALESCE(pr.dislikes_count, 0)      AS dislikes_count,
            COALESCE(pr.likes_weight, '0')      AS likes_weight,
            COALESCE(pr.dislikes_weight, '0')   AS dislikes_weight,
            COALESCE(pr.my_reaction, '')        AS my_reaction,
            COALESCE(tj.status, '')             AS job_status,
            COALESCE(cc.cnt, 0)                 AS comment_count
        FROM gonka_vote.proposals AS t FINAL
        LEFT JOIN gonka_vote.users  AS u  FINAL ON u.email = t.creator_email
        LEFT JOIN proposal_reactions_agg AS pr  ON pr.proposal_id = t.id
        LEFT JOIN proposal_jobs     AS tj        ON tj.entity_id = t.id
        LEFT JOIN comment_counts    AS cc        ON cc.entity_id = t.id
        LEFT JOIN gonka_vote.proposal_translations AS ttx FINAL
                  ON ttx.proposal_id = t.id AND ttx.target_lang = {{lang:String}}
        WHERE t.deleted_at IS NULL
        ORDER BY t.created_at DESC
        """,
        {"lang": target_lang, "me_uid": me_uid},
    )
    return [_row_to_summary(r, target_lang) for r in rows]


@router.post("/proposal", status_code=201)
@router.post("/tenders", status_code=201, include_in_schema=False)
async def create_proposal(
    payload: ProposalCreate,
    user: dict = Depends(current_user),
) -> ProposalSummary:
    if payload.closes_at is None:
        raise HTTPException(422, "closes_at is required")
    closes_at = payload.closes_at
    if closes_at.tzinfo is None:
        closes_at = closes_at.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if closes_at - now < MIN_DEADLINE_DELTA - DEADLINE_GRACE:
        raise HTTPException(
            422,
            f"closes_at must be at least {MIN_DEADLINE_DELTA.days} days from now",
        )
    if closes_at - now > MAX_DEADLINE_DELTA + DEADLINE_GRACE:
        raise HTTPException(
            422,
            f"closes_at must be at most {MAX_DEADLINE_DELTA.days} days from now",
        )
    if payload.requested_amount_usdt == 0 and payload.requested_amount_gnk == 0:
        raise HTTPException(422, "at least one of requested_amount_usdt / _gnk must be > 0")

    ch = _ensure_ch()
    new_id = uuid4()
    short_id = ""
    for _ in range(10):
        candidate = _generate_short_id()
        existing = await ch.query_scalar(
            "SELECT count() FROM gonka_vote.proposals FINAL "
            "WHERE short_id = {sid:String}",
            {"sid": candidate},
        )
        if not existing:
            short_id = candidate
            break
    if not short_id:
        raise HTTPException(500, "could not allocate short_id")
    await ch.insert(
        "proposals",
        ["id", "short_id", "title", "summary", "description", "creator_email",
         "creator_wallet", "status", "created_at", "closes_at", "creator_uid",
         "source_lang", "requested_amount_usdt", "requested_amount_gnk"],
        [[
            new_id,
            short_id,
            payload.title,
            payload.summary,
            payload.description,
            user["email"],
            user.get("wallet_address"),
            "open",
            now,
            closes_at,
            user["uid"],
            "",
            payload.requested_amount_usdt,
            payload.requested_amount_gnk,
        ]],
    )
    try:
        await enqueue_detect(ch, "proposal", new_id)
    except Exception as e:
        logger.warning("enqueue_detect(proposal) failed for %s: %s", new_id, e)
    return ProposalSummary(
        id=new_id,
        short_id=short_id,
        title=payload.title,
        summary=payload.summary,
        creator_uid=user["uid"],
        creator_name=user.get("name"),
        creator_image=user.get("image"),
        status="open",
        created_at=now,
        closes_at=closes_at,
        requested_amount_usdt=payload.requested_amount_usdt,
        requested_amount_gnk=payload.requested_amount_gnk,
        source_lang="",
        translation_status="pending" if len(supported_languages()) > 1 else "ready",
    )


async def _resolve_proposal_uuid(ch, proposal_id: str) -> UUID:
    """Accepts either a UUID or a 6-char short_id. Returns the canonical UUID."""
    try:
        return UUID(proposal_id)
    except (ValueError, AttributeError):
        pass
    if len(proposal_id) != SHORT_ID_LEN or any(
        c not in SHORT_ID_ALPHABET for c in proposal_id
    ):
        raise HTTPException(404, "proposal not found")
    row = await ch.query_one(
        "SELECT id FROM gonka_vote.proposals FINAL "
        "WHERE short_id = {sid:String} AND deleted_at IS NULL",
        {"sid": proposal_id},
    )
    if not row:
        raise HTTPException(404, "proposal not found")
    return UUID(str(row["id"]))


@router.get("/proposal/{proposal_id}")
@router.get("/tenders/{proposal_id}", include_in_schema=False)
async def get_proposal(
    proposal_id: str,
    request: Request,
    lang: Optional[str] = None,
) -> ProposalDetail:
    ch = _ensure_ch()
    canonical = await _resolve_proposal_uuid(ch, proposal_id)
    target_lang = (lang or "").strip().lower()
    me_record = await current_user_optional(request)
    me_uid = me_record["uid"] if me_record else ""
    t = await ch.query_one(
        f"""
        WITH
        {_REACTIONS_CTE.strip().rstrip(',')}
        SELECT
            t.id              AS id,
            t.short_id        AS short_id,
            t.title           AS title,
            t.summary         AS summary,
            t.description     AS description,
            t.source_lang     AS source_lang,
            ttx.title         AS title_t,
            ttx.summary       AS summary_t,
            ttx.description   AS description_t,
            COALESCE(NULLIF(t.creator_uid, ''), u.uid, '') AS creator_uid,
            u.name            AS creator_name,
            u.image           AS creator_image,
            t.creator_wallet  AS creator_wallet,
            t.status          AS status,
            t.created_at      AS created_at,
            t.closes_at       AS closes_at,
            toUInt64(t.requested_amount_usdt) AS requested_amount_usdt,
            toUInt64(t.requested_amount_gnk)  AS requested_amount_gnk,
            COALESCE(pr.likes_count, 0)       AS likes_count,
            COALESCE(pr.dislikes_count, 0)    AS dislikes_count,
            COALESCE(pr.likes_weight, '0')    AS likes_weight,
            COALESCE(pr.dislikes_weight, '0') AS dislikes_weight,
            COALESCE(pr.my_reaction, '')      AS my_reaction,
            COALESCE(tj.status, '')           AS job_status
        FROM gonka_vote.proposals AS t FINAL
        LEFT JOIN gonka_vote.users AS u FINAL ON u.email = t.creator_email
        LEFT JOIN proposal_reactions_agg AS pr ON pr.proposal_id = t.id
        LEFT JOIN gonka_vote.translation_jobs AS tj FINAL
                  ON tj.kind = 'proposal' AND tj.entity_id = t.id AND tj.target_lang = {{lang:String}}
        LEFT JOIN gonka_vote.proposal_translations AS ttx FINAL
                  ON ttx.proposal_id = t.id AND ttx.target_lang = {{lang:String}}
        WHERE t.id = {{id:UUID}} AND t.deleted_at IS NULL
        """,
        {"id": str(canonical), "lang": target_lang, "me_uid": me_uid},
    )
    if not t:
        raise HTTPException(404, "proposal not found")

    comment_count = await ch.query_scalar(
        "SELECT count() FROM gonka_vote.comments "
        "WHERE entity_id = {id:UUID} AND deleted_at IS NULL",
        {"id": str(canonical)},
    )

    source_lang = (t.get("source_lang") or "")
    job_status = t.get("job_status") or ""
    title_show, t_is_t, t_status = _pick_translation(
        t["title"], t.get("title_t") or "", source_lang, target_lang, job_status,
    )
    summary_show, s_is_t, _ = _pick_translation(
        t.get("summary") or "", t.get("summary_t") or "", source_lang, target_lang, job_status,
    )
    desc_show, d_is_t, _ = _pick_translation(
        t["description"], t.get("description_t") or "", source_lang, target_lang, job_status,
    )
    is_translated = t_is_t or s_is_t or d_is_t
    return ProposalDetail(
        id=t["id"],
        short_id=(t.get("short_id") or ""),
        title=title_show,
        summary=summary_show,
        description=desc_show,
        creator_uid=t["creator_uid"] or "",
        creator_name=t.get("creator_name"),
        creator_image=t.get("creator_image"),
        creator_wallet=t.get("creator_wallet"),
        status=t["status"],
        created_at=t["created_at"],
        closes_at=t.get("closes_at"),
        requested_amount_usdt=int(t.get("requested_amount_usdt") or 0),
        requested_amount_gnk=int(t.get("requested_amount_gnk") or 0),
        likes_count=int(t.get("likes_count") or 0),
        dislikes_count=int(t.get("dislikes_count") or 0),
        likes_weight_ngonka=str(t.get("likes_weight") or "0"),
        dislikes_weight_ngonka=str(t.get("dislikes_weight") or "0"),
        my_reaction=(t.get("my_reaction") or None) or None,
        comment_count=int(comment_count or 0),
        source_lang=source_lang,
        is_translated=is_translated,
        translation_status=t_status,
        original_title=t["title"] if is_translated else None,
        original_summary=(t.get("summary") or "") if is_translated else None,
        original_description=t["description"] if is_translated else None,
    )


@router.post("/proposal/{proposal_id}/close")
@router.post("/tenders/{proposal_id}/close", include_in_schema=False)
async def close_proposal(proposal_id: str, user: dict = Depends(current_user)):
    ch = _ensure_ch()
    canonical = await _resolve_proposal_uuid(ch, proposal_id)
    t = await ch.query_one(
        "SELECT short_id, creator_email, status, title, summary, description, created_at, "
        "closes_at, creator_wallet, creator_uid, requested_amount_usdt, requested_amount_gnk "
        "FROM gonka_vote.proposals FINAL "
        "WHERE id = {id:UUID} AND deleted_at IS NULL",
        {"id": str(canonical)},
    )
    if not t:
        raise HTTPException(404, "proposal not found")
    if t["creator_email"] != user["email"]:
        raise HTTPException(403, "only the creator can close")

    await ch.insert(
        "proposals",
        ["id", "short_id", "title", "summary", "description", "creator_email",
         "creator_wallet", "status", "created_at", "closes_at", "creator_uid",
         "requested_amount_usdt", "requested_amount_gnk"],
        [[
            canonical,
            t.get("short_id") or "",
            t["title"],
            t.get("summary") or "",
            t["description"],
            t["creator_email"],
            t.get("creator_wallet"),
            "closed",
            t["created_at"],
            t.get("closes_at"),
            t.get("creator_uid") or user["uid"],
            int(t.get("requested_amount_usdt") or 0),
            int(t.get("requested_amount_gnk") or 0),
        ]],
    )
    return {"ok": True}


@router.delete("/proposal/{proposal_id}")
@router.delete("/tenders/{proposal_id}", include_in_schema=False)
async def delete_proposal(proposal_id: str, user: dict = Depends(current_user)):
    """Soft delete a proposal. Allowed for the creator or any admin.
    Cascades to all comments on this proposal."""
    ch = _ensure_ch()
    canonical = await _resolve_proposal_uuid(ch, proposal_id)
    t = await ch.query_one(
        "SELECT id, short_id, title, summary, description, creator_email, creator_wallet, "
        "status, created_at, closes_at, creator_uid, requested_amount_usdt, requested_amount_gnk "
        "FROM gonka_vote.proposals FINAL "
        "WHERE id = {id:UUID} AND deleted_at IS NULL",
        {"id": str(canonical)},
    )
    if not t:
        raise HTTPException(404, "proposal not found")

    if not user.get("is_admin") and t["creator_email"] != user["email"]:
        raise HTTPException(403, "only the creator or an admin can delete")

    now = datetime.now(timezone.utc)

    await ch.insert(
        "proposals",
        ["id", "short_id", "title", "summary", "description", "creator_email",
         "creator_wallet", "status", "created_at", "closes_at", "creator_uid",
         "requested_amount_usdt", "requested_amount_gnk",
         "deleted_at", "deleted_by_email"],
        [[
            canonical,
            t.get("short_id") or "",
            t["title"],
            t.get("summary") or "",
            t["description"],
            t["creator_email"],
            t.get("creator_wallet"),
            t["status"],
            t["created_at"],
            t.get("closes_at"),
            t.get("creator_uid") or "",
            int(t.get("requested_amount_usdt") or 0),
            int(t.get("requested_amount_gnk") or 0),
            now,
            user["email"],
        ]],
    )

    # Cascade: soft-delete comments. comments is plain MergeTree (no upsert),
    # so we issue an ALTER UPDATE mutation (async, finishes within seconds).
    await ch.command(
        "ALTER TABLE gonka_vote.comments "
        "UPDATE deleted_at = now64(3), deleted_by_email = {by:String} "
        "WHERE entity_id = {tid:UUID} AND deleted_at IS NULL",
        {"by": user["email"], "tid": str(canonical)},
    )

    return {"ok": True}


# ----------------------------------------------------------------------------
# Comments
# ----------------------------------------------------------------------------

@router.get("/proposal/{proposal_id}/comments")
@router.get("/tenders/{proposal_id}/comments", include_in_schema=False)
async def list_comments(
    proposal_id: str,
    request: Request,
    lang: Optional[str] = None,
) -> list[CommentOut]:
    ch = _ensure_ch()
    canonical = await _resolve_proposal_uuid(ch, proposal_id)
    target_lang = (lang or "").strip().lower()
    me_record = await current_user_optional(request)
    me_uid = me_record["uid"] if me_record else ""

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
        WHERE c.entity_id = {id:UUID} AND c.deleted_at IS NULL
        GROUP BY c.id, c.parent_comment_id, c.author_uid, c.author_name,
                 u.uid, u.name, u.image, c.body, c.source_lang, ct.body,
                 c.created_at, tj.status
        -- Top score first; on tie, oldest first (stable, rewards early posts).
        ORDER BY (toInt64(countIf(r.reaction_type = 'like'))
                  - toInt64(countIf(r.reaction_type = 'dislike'))) DESC,
                 c.created_at ASC
        """,
        {"id": str(canonical), "me_uid": me_uid, "lang": target_lang},
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


@router.post("/proposal/{proposal_id}/comments", status_code=201)
@router.post("/tenders/{proposal_id}/comments", status_code=201, include_in_schema=False)
async def add_comment(
    proposal_id: str,
    payload: CommentCreate,
    user: dict = Depends(current_user),
) -> CommentOut:
    ch = _ensure_ch()
    canonical = await _resolve_proposal_uuid(ch, proposal_id)

    if payload.parent_comment_id is not None:
        parent_entity = await ch.query_scalar(
            "SELECT entity_id FROM gonka_vote.comments "
            "WHERE id = {pid:UUID} AND deleted_at IS NULL LIMIT 1",
            {"pid": str(payload.parent_comment_id)},
        )
        if parent_entity is None:
            raise HTTPException(404, "parent comment not found")
        if str(parent_entity) != str(canonical):
            raise HTTPException(400, "parent comment belongs to a different proposal")

    cid = uuid4()
    now = datetime.now(timezone.utc)
    # source_lang stays empty until the worker resolves it via AI detection
    # (see worker._process_detect). Keeps add_comment fast.
    await ch.insert(
        "comments",
        ["id", "entity_id", "author_email", "author_name", "body", "created_at",
         "parent_comment_id", "author_uid", "source_lang"],
        [[cid, canonical, user["email"], user.get("name"), payload.body, now,
          payload.parent_comment_id, user["uid"], ""]],
    )
    try:
        await enqueue_detect(ch, "comment", cid)
    except Exception as e:
        logger.warning("enqueue_detect(comment) failed for %s: %s", cid, e)
    await enqueue_comment_notifications(ch, cid)
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


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: UUID, admin: dict = Depends(current_admin)):
    """Admin-only soft delete for a single comment (does not touch replies)."""
    ch = _ensure_ch()
    exists = await ch.query_scalar(
        "SELECT 1 FROM gonka_vote.comments "
        "WHERE id = {cid:UUID} AND deleted_at IS NULL LIMIT 1",
        {"cid": str(comment_id)},
    )
    if not exists:
        raise HTTPException(404, "comment not found")
    await ch.command(
        "ALTER TABLE gonka_vote.comments "
        "UPDATE deleted_at = now64(3), deleted_by_email = {by:String} "
        "WHERE id = {cid:UUID}",
        {"by": admin["email"], "cid": str(comment_id)},
    )
    return {"ok": True}


# ----------------------------------------------------------------------------
# Reactions
# ----------------------------------------------------------------------------

@router.post("/comments/{comment_id}/reactions")
async def upsert_reaction(
    comment_id: UUID,
    payload: ReactionUpsert,
    user: dict = Depends(current_user),
) -> dict:
    """Set, change, or remove the current user's reaction on a comment.

    payload.reaction = 'like' | 'dislike' to set/change; '' to remove.
    Idempotent.
    """
    ch = _ensure_ch()
    exists = await ch.query_scalar(
        "SELECT 1 FROM gonka_vote.comments "
        "WHERE id = {cid:UUID} AND deleted_at IS NULL LIMIT 1",
        {"cid": str(comment_id)},
    )
    if not exists:
        raise HTTPException(404, "comment not found")

    await ch.insert(
        "comment_reactions",
        ["comment_id", "reactor_uid", "reaction_type", "updated_at"],
        [[comment_id, user["uid"], payload.reaction, datetime.now(timezone.utc)]],
    )
    return {"ok": True, "reaction": payload.reaction or None}


@router.post("/proposal/{proposal_id}/reactions")
@router.post("/tenders/{proposal_id}/reactions", include_in_schema=False)
async def upsert_proposal_reaction(
    proposal_id: str,
    payload: ReactionUpsert,
    user: dict = Depends(current_user),
) -> dict:
    """Same shape as /comments/{id}/reactions but for proposals."""
    ch = _ensure_ch()
    canonical = await _resolve_proposal_uuid(ch, proposal_id)
    await ch.insert(
        "proposal_reactions",
        ["proposal_id", "reactor_uid", "reaction_type", "updated_at"],
        [[canonical, user["uid"], payload.reaction, datetime.now(timezone.utc)]],
    )
    return {"ok": True, "reaction": payload.reaction or None}


# ----------------------------------------------------------------------------
# Linked wallets — the /me settings page shows which chain wallets the current
# user has bound via the LinkAccount contract. Indexer populates wallet_links
# from on-chain events; balance_refresher refreshes balance_ngonka hourly.
# ----------------------------------------------------------------------------

@router.get("/wallets/mine")
async def my_wallets(user: dict = Depends(current_user)) -> list[LinkedWallet]:
    ch = _ensure_ch()
    rows = await ch.query_rows(
        """
        SELECT wallet,
               toString(balance_ngonka)   AS balance_ngonka,
               linked_at                  AS linked_at,
               balance_refreshed_at       AS balance_refreshed_at
        FROM gonka_vote.wallet_links FINAL
        WHERE account_uid = {uid:String} AND unlinked_at IS NULL
        ORDER BY linked_at DESC
        """,
        {"uid": user["uid"]},
    )
    return [LinkedWallet(**r) for r in rows]


@router.post("/wallets/refresh")
async def refresh_wallets(user: dict = Depends(current_user)) -> dict:
    """Trigger indexer to scan the link contract and refresh balances for the
    current user's wallets. Rate-limited to 6 calls/min server-wide by the
    indexer (returns 429 if exceeded)."""
    url = f"{settings.indexer_url.rstrip('/')}/refresh"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, params={"uid": user["uid"]})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"indexer unreachable: {e}")
    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="rate_limited")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"indexer error: {resp.text}")
    return resp.json()


# ----------------------------------------------------------------------------
# Public user profile (by uid). Email is intentionally not returned.
# ----------------------------------------------------------------------------

@router.get("/users/{uid}")
async def public_profile(
    uid: str,
    request: Request,
    lang: Optional[str] = None,
) -> UserPublicProfile:
    ch = _ensure_ch()
    target_lang = (lang or "").strip().lower()
    me_record = await current_user_optional(request)
    me_uid = me_record["uid"] if me_record else ""
    u = await ch.query_one(
        """
        SELECT uid, email, name, image, wallet_address
        FROM gonka_vote.users FINAL
        WHERE uid = {uid:String}
        LIMIT 1
        """,
        {"uid": uid},
    )
    if not u:
        raise HTTPException(404, "user not found")

    rows = await ch.query_rows(
        f"""
        WITH
        {_REACTIONS_CTE.strip().rstrip(',')}
        SELECT
            t.id            AS id,
            t.short_id      AS short_id,
            t.title         AS title,
            t.summary       AS summary,
            t.source_lang   AS source_lang,
            ttx.title       AS title_t,
            ttx.summary     AS summary_t,
            {{uid:String}}    AS creator_uid,
            {{name:String}}   AS creator_name,
            {{image:String}}  AS creator_image,
            t.status        AS status,
            t.created_at    AS created_at,
            t.closes_at     AS closes_at,
            toUInt64(t.requested_amount_usdt) AS requested_amount_usdt,
            toUInt64(t.requested_amount_gnk)  AS requested_amount_gnk,
            COALESCE(pr.likes_count, 0)         AS likes_count,
            COALESCE(pr.dislikes_count, 0)      AS dislikes_count,
            COALESCE(pr.likes_weight, '0')      AS likes_weight,
            COALESCE(pr.dislikes_weight, '0')   AS dislikes_weight,
            COALESCE(pr.my_reaction, '')        AS my_reaction
        FROM gonka_vote.proposals AS t FINAL
        LEFT JOIN proposal_reactions_agg AS pr ON pr.proposal_id = t.id
        LEFT JOIN gonka_vote.proposal_translations AS ttx FINAL
                  ON ttx.proposal_id = t.id AND ttx.target_lang = {{lang:String}}
        WHERE t.deleted_at IS NULL
          AND (t.creator_email = {{email:String}} OR t.creator_uid = {{uid:String}})
        ORDER BY t.created_at DESC
        """,
        {
            "uid": uid,
            "email": u["email"],
            "name": u.get("name") or "",
            "image": u.get("image") or "",
            "lang": target_lang,
            "me_uid": me_uid,
        },
    )
    weight = await ch.query_one(
        """
        SELECT toString(sum(balance_ngonka)) AS total,
               count()                       AS n
        FROM gonka_vote.wallet_links FINAL
        WHERE account_uid = {uid:String} AND unlinked_at IS NULL
        """,
        {"uid": uid},
    )
    return UserPublicProfile(
        uid=u["uid"],
        name=u.get("name"),
        image=u.get("image"),
        wallet_address=u.get("wallet_address"),
        total_weight_ngonka=(weight or {}).get("total") or "0",
        linked_wallets_count=int((weight or {}).get("n") or 0),
        proposals=[_row_to_summary(r, target_lang) for r in rows],
    )


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _pick_translation(
    original: str,
    translation: str,
    source_lang: str,
    target_lang: str,
    job_status: str,
) -> tuple[str, bool, str]:
    """Decide which text to serve and what status to report.

    Returns (text_to_show, is_translated, translation_status).
    - If no target_lang requested, or it equals source, or no source known →
      show original, status='ready', is_translated=False.
    - If translation present in `*_t.{target_lang}` → use it, is_translated=True.
    - Else look at the job: pending/running → 'pending', failed → 'failed',
      missing → 'pending' (worker hasn't picked it up yet).
    """
    if not target_lang or not source_lang or target_lang == source_lang:
        return original, False, "ready"
    if translation:
        return translation, True, "ready"
    if job_status in ("pending", "running", ""):
        return original, False, "pending"
    if job_status == "failed":
        return original, False, "failed"
    return original, False, "ready"


def _row_to_summary(r: dict, target_lang: str = "") -> ProposalSummary:
    creator_image = r.get("creator_image")
    source_lang = (r.get("source_lang") or "")
    title_show, title_is_t, t_status = _pick_translation(
        r["title"], r.get("title_t") or "", source_lang, target_lang,
        r.get("job_status") or "",
    )
    summary_show, summary_is_t, _ = _pick_translation(
        r.get("summary") or "", r.get("summary_t") or "", source_lang, target_lang,
        r.get("job_status") or "",
    )
    is_translated = title_is_t or summary_is_t
    return ProposalSummary(
        id=r["id"],
        short_id=(r.get("short_id") or ""),
        title=title_show,
        summary=summary_show,
        creator_uid=(r.get("creator_uid") or ""),
        creator_name=(r.get("creator_name") or None),
        creator_image=(creator_image if creator_image else None),
        status=r["status"],
        created_at=r["created_at"],
        closes_at=r.get("closes_at"),
        requested_amount_usdt=int(r.get("requested_amount_usdt") or 0),
        requested_amount_gnk=int(r.get("requested_amount_gnk") or 0),
        likes_count=int(r.get("likes_count") or 0),
        dislikes_count=int(r.get("dislikes_count") or 0),
        likes_weight_ngonka=str(r.get("likes_weight") or "0"),
        dislikes_weight_ngonka=str(r.get("dislikes_weight") or "0"),
        my_reaction=(r.get("my_reaction") or None) or None,
        comment_count=int(r.get("comment_count") or 0),
        source_lang=source_lang,
        is_translated=is_translated,
        original_title=r["title"] if is_translated else None,
        original_summary=(r.get("summary") or "") if is_translated else None,
        translation_status=t_status,
    )
