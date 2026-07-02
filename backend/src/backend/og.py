"""SSR endpoint that serves a minimal HTML page for crawler/bot user-agents
(Googlebot, Bingbot, Twitterbot, facebookexternalhit, LinkedInBot,
TelegramBot, etc.). Real browsers go through the SPA on nginx and never hit
this endpoint; Traefik routes bot traffic here via a User-Agent matcher
(see docker-compose.yaml).

Without this layer, a search bot fetching the SPA shell would only see an
empty `<div id="root">` plus a generic site-wide title — and would either
defer the page to the JS-rendering second pass (days/weeks of latency) or
collapse every URL into a single duplicate. The SSR layer feeds each crawl
a unique title, description, h1, and canonical URL straight from the DB.
"""
from __future__ import annotations

import html
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

from backend.auth import _ensure_ch  # type: ignore
from backend.settings import settings

logger = logging.getLogger(__name__)

og_router = APIRouter()

DEFAULT_TITLE = "Gonka Vote — Community proposals & on-chain governance"
DEFAULT_DESCRIPTION = (
    "Propose ideas, discuss them, and vote on on-chain proposals for the "
    "Gonka network. GNK-weighted indicative polls plus a translated mirror "
    "of every governance proposal."
)
def _site_base() -> str:
    """Public site URL stripped of trailing slash. Single source for SSR
    canonical URLs, OG tags, and sitemap entries."""
    return settings.public_base_url.rstrip("/")


SITE_BASE = _site_base()


# ----------------------------------------------------------------------------
# HTML template — same shell for every page; only meta + body content varies.
# ----------------------------------------------------------------------------

def _render(*, title: str, description: str, url: str, body: str) -> str:
    t = html.escape(title)
    d = html.escape(description)
    u = html.escape(url)
    return (
        f"<!doctype html><html lang=\"en\"><head>"
        f"<meta charset=\"utf-8\">"
        f"<title>{t}</title>"
        f"<meta name=\"description\" content=\"{d}\">"
        f"<meta name=\"robots\" content=\"index, follow, max-image-preview:large\">"
        f"<meta name=\"author\" content=\"Gonka Vote\">"
        f"<link rel=\"canonical\" href=\"{u}\">"
        f"<meta property=\"og:site_name\" content=\"Gonka Vote\">"
        f"<meta property=\"og:type\" content=\"article\">"
        f"<meta property=\"og:url\" content=\"{u}\">"
        f"<meta property=\"og:title\" content=\"{t}\">"
        f"<meta property=\"og:description\" content=\"{d}\">"
        f"<meta property=\"og:image\" content=\"{SITE_BASE}/images/prev.jpg\">"
        f"<meta name=\"twitter:card\" content=\"summary_large_image\">"
        f"<meta name=\"twitter:title\" content=\"{t}\">"
        f"<meta name=\"twitter:description\" content=\"{d}\">"
        f"<meta name=\"twitter:image\" content=\"{SITE_BASE}/images/prev.jpg\">"
        f"</head><body>{body}</body></html>"
    )


def _short(s: str, n: int = 200) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------

@og_router.get("/", response_class=HTMLResponse)
async def og_home(request: Request) -> HTMLResponse:
    """Index page summary + list of recent proposal titles for inbound crawlers."""
    url = SITE_BASE + "/"
    body_lines: list[str] = [
        f"<h1>{html.escape(DEFAULT_TITLE)}</h1>",
        f"<p>{html.escape(DEFAULT_DESCRIPTION)}</p>",
    ]
    try:
        ch = _ensure_ch()
        rows = await ch.query_rows(
            """
            SELECT id, title, summary
            FROM gonka_vote.proposals FINAL
            WHERE deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 50
            """
        )
        if rows:
            body_lines.append("<h2>Recent proposals</h2><ul>")
            for r in rows:
                tid = str(r["id"])
                ttitle = html.escape(_short(r.get("title") or "", 120))
                tsum = html.escape(_short(r.get("summary") or "", 200))
                body_lines.append(
                    f"<li><a href=\"{SITE_BASE}/proposal/{tid}\">{ttitle}</a>"
                    f"{(': ' + tsum) if tsum else ''}</li>"
                )
            body_lines.append("</ul>")
    except Exception as e:
        logger.warning("og home: failed to enrich body: %s", e)
    return HTMLResponse(
        _render(
            title=DEFAULT_TITLE,
            description=DEFAULT_DESCRIPTION,
            url=url,
            body="".join(body_lines),
        ),
        headers={"Cache-Control": "public, max-age=300"},
    )


@og_router.get("/proposal/{proposal_id}", response_class=HTMLResponse)
async def og_proposal(proposal_id: UUID, request: Request) -> HTMLResponse:
    url = f"{SITE_BASE}/proposal/{proposal_id}"
    fallback_body = f"<a href=\"{html.escape(url)}\">{html.escape(DEFAULT_TITLE)}</a>"
    fallback = HTMLResponse(
        _render(title=DEFAULT_TITLE, description=DEFAULT_DESCRIPTION, url=url, body=fallback_body),
        headers={"Cache-Control": "public, max-age=60"},
    )
    try:
        ch = _ensure_ch()
        row = await ch.query_one(
            """
            SELECT title, summary, description
            FROM gonka_vote.proposals FINAL
            WHERE id = {id:UUID} AND deleted_at IS NULL
            """,
            {"id": str(proposal_id)},
        )
    except Exception as e:
        logger.warning("og proposal %s: %s", proposal_id, e)
        return fallback
    if not row:
        return fallback

    title = (row.get("title") or "").strip() or DEFAULT_TITLE
    summary = (row.get("summary") or "").strip()
    desc = summary or DEFAULT_DESCRIPTION
    body_text = (row.get("description") or "").strip()
    body = (
        f"<h1>{html.escape(title)}</h1>"
        f"<p>{html.escape(_short(summary, 320))}</p>"
        f"<div>{html.escape(_short(body_text, 1500))}</div>"
    )
    return HTMLResponse(
        _render(title=title, description=_short(desc, 200), url=url, body=body),
        headers={"Cache-Control": "public, max-age=300"},
    )


@og_router.get("/governance", response_class=HTMLResponse)
async def og_governance_list(request: Request) -> HTMLResponse:
    url = SITE_BASE + "/governance"
    title = "Governance proposals — Gonka Vote"
    desc = (
        "On-chain governance proposals for Gonka: software upgrades, parameter "
        "changes, community spending. Discussion, translations, and voting in one place."
    )
    body_lines = [f"<h1>{html.escape(title)}</h1>", f"<p>{html.escape(desc)}</p>"]
    try:
        ch = _ensure_ch()
        rows = await ch.query_rows(
            """
            SELECT proposal_id, title, summary, status
            FROM gonka_vote.gov_proposals FINAL
            ORDER BY proposal_id DESC
            LIMIT 100
            """
        )
        if rows:
            body_lines.append("<h2>Latest proposals</h2><ul>")
            for r in rows:
                pid = int(r["proposal_id"])
                ptitle = html.escape(_short(r.get("title") or "", 140))
                pstatus = html.escape((r.get("status") or "").strip())
                body_lines.append(
                    f"<li><a href=\"{SITE_BASE}/governance/{pid}\">"
                    f"#{pid} {ptitle}</a> — {pstatus}</li>"
                )
            body_lines.append("</ul>")
    except Exception as e:
        logger.warning("og governance list: %s", e)
    return HTMLResponse(
        _render(title=title, description=desc, url=url, body="".join(body_lines)),
        headers={"Cache-Control": "public, max-age=300"},
    )


@og_router.get("/governance/{proposal_id:int}", response_class=HTMLResponse)
async def og_governance_proposal(proposal_id: int, request: Request) -> HTMLResponse:
    url = f"{SITE_BASE}/governance/{proposal_id}"
    fallback_body = f"<a href=\"{html.escape(url)}\">Proposal #{proposal_id}</a>"
    fallback = HTMLResponse(
        _render(title=DEFAULT_TITLE, description=DEFAULT_DESCRIPTION, url=url, body=fallback_body),
        headers={"Cache-Control": "public, max-age=60"},
    )
    try:
        ch = _ensure_ch()
        row = await ch.query_one(
            """
            SELECT proposal_id, title, summary, status, proposer
            FROM gonka_vote.gov_proposals FINAL
            WHERE proposal_id = {pid:UInt32}
            """,
            {"pid": proposal_id},
        )
    except Exception as e:
        logger.warning("og gov proposal %s: %s", proposal_id, e)
        return fallback
    if not row:
        return fallback

    raw_title = (row.get("title") or "").strip() or f"Proposal #{proposal_id}"
    title = f"#{proposal_id} {raw_title} — Gonka Governance"
    summary = (row.get("summary") or "").strip()
    desc = summary or DEFAULT_DESCRIPTION
    body = (
        f"<h1>#{proposal_id} {html.escape(raw_title)}</h1>"
        f"<p><strong>Status:</strong> {html.escape(row.get('status') or '')} · "
        f"<strong>Proposer:</strong> {html.escape(row.get('proposer') or '')}</p>"
        f"<div>{html.escape(_short(summary, 1500))}</div>"
    )
    return HTMLResponse(
        _render(title=title, description=_short(desc, 200), url=url, body=body),
        headers={"Cache-Control": "public, max-age=300"},
    )


# ----------------------------------------------------------------------------
# /sitemap.xml — full URL list for search engines.
# Cacheable, regenerated on each request (cheap two-table SELECT).
# ----------------------------------------------------------------------------

@og_router.get("/sitemap.xml", include_in_schema=False)
async def sitemap() -> Response:
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    urls: list[str] = []

    def _u(loc: str, lastmod: str, priority: str, changefreq: str) -> str:
        return (
            f"<url><loc>{html.escape(loc)}</loc>"
            f"<lastmod>{lastmod}</lastmod>"
            f"<changefreq>{changefreq}</changefreq>"
            f"<priority>{priority}</priority></url>"
        )

    # Static entries.
    urls.append(_u(SITE_BASE + "/", now_iso, "1.0", "hourly"))
    urls.append(_u(SITE_BASE + "/governance", now_iso, "0.9", "hourly"))
    urls.append(_u(SITE_BASE + "/privacy", now_iso, "0.3", "monthly"))
    urls.append(_u(SITE_BASE + "/terms", now_iso, "0.3", "monthly"))

    try:
        ch = _ensure_ch()
        for r in await ch.query_rows(
            """
            SELECT id, COALESCE(updated_at, created_at) AS lastmod
            FROM gonka_vote.proposals FINAL
            WHERE deleted_at IS NULL
            ORDER BY lastmod DESC
            LIMIT 5000
            """
        ):
            lm = r["lastmod"]
            iso = lm.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(lm, datetime) else now_iso
            urls.append(_u(f"{SITE_BASE}/proposal/{r['id']}", iso, "0.7", "daily"))

        for r in await ch.query_rows(
            """
            SELECT proposal_id, fetched_at AS lastmod
            FROM gonka_vote.gov_proposals FINAL
            ORDER BY proposal_id DESC
            LIMIT 5000
            """
        ):
            lm = r["lastmod"]
            iso = lm.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(lm, datetime) else now_iso
            urls.append(_u(f"{SITE_BASE}/governance/{int(r['proposal_id'])}", iso, "0.7", "daily"))
    except Exception as e:
        logger.warning("sitemap enrichment failed: %s", e)

    body = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">"
        + "".join(urls)
        + "</urlset>"
    )
    return Response(
        content=body,
        media_type="application/xml",
        headers={"Cache-Control": "public, max-age=600"},
    )
