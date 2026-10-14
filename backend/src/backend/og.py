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
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response

from backend import og_images
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

INDEX = "index, follow, max-image-preview:large"
NOINDEX = "noindex, follow"


# Share images: the site's own pages have static cards in
# frontend/public/images/preview/; proposals get theirs drawn from their data
# (og_images.py, /api/og/... below).
SITE_IMAGE = f"{SITE_BASE}/images/preview/gonka-vote.jpg"
GOVERNANCE_IMAGE = f"{SITE_BASE}/images/preview/governance.jpg"


def _render(*, title: str, description: str, url: str, body: str, robots: str = INDEX,
            image: str = SITE_IMAGE) -> str:
    t = html.escape(title)
    d = html.escape(description)
    u = html.escape(url)
    return (
        f"<!doctype html><html lang=\"en\"><head>"
        f"<meta charset=\"utf-8\">"
        f"<title>{t}</title>"
        f"<meta name=\"description\" content=\"{d}\">"
        f"<meta name=\"robots\" content=\"{robots}\">"
        f"<meta name=\"author\" content=\"Gonka Vote\">"
        f"<link rel=\"canonical\" href=\"{u}\">"
        # Google picks a site's search-result icon from the <link rel=icon>
        # on the homepage -- and crawlers get the homepage from here, not the
        # SPA, so without these it fell back to /favicon.ico.
        f"<link rel=\"icon\" href=\"{SITE_BASE}/favicon.ico\" sizes=\"any\">"
        f"<link rel=\"icon\" type=\"image/png\" sizes=\"48x48\" href=\"{SITE_BASE}/favicon-48x48.png\">"
        f"<link rel=\"icon\" type=\"image/svg+xml\" href=\"{SITE_BASE}/images/logo.svg\">"
        f"<meta property=\"og:site_name\" content=\"Gonka Vote\">"
        f"<meta property=\"og:type\" content=\"article\">"
        f"<meta property=\"og:url\" content=\"{u}\">"
        f"<meta property=\"og:title\" content=\"{t}\">"
        f"<meta property=\"og:description\" content=\"{d}\">"
        f"<meta property=\"og:image\" content=\"{html.escape(image)}\">"
        f"<meta name=\"twitter:card\" content=\"summary_large_image\">"
        f"<meta name=\"twitter:title\" content=\"{t}\">"
        f"<meta name=\"twitter:description\" content=\"{d}\">"
        f"<meta name=\"twitter:image\" content=\"{html.escape(image)}\">"
        f"</head><body>{body}</body></html>"
    )


def _not_found() -> HTMLResponse:
    """404 for an id that does not resolve to a proposal.

    These routes used to answer 200 with the site-wide title and a canonical
    pointing at the bad URL, which Google files as a soft 404 -- and every
    typo or deleted proposal became an indexable thin page.
    """
    return HTMLResponse(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<title>Not found — Gonka Vote</title>"
        "<meta name=\"robots\" content=\"noindex\">"
        "</head><body><h1>Not found</h1></body></html>",
        status_code=404,
        headers={"Cache-Control": "public, max-age=60"},
    )


def _unavailable() -> HTMLResponse:
    """503 when the lookup itself failed.

    A database hiccup is not evidence the page is gone, so it must not look
    like either a real page or a 404: 503 with Retry-After tells the crawler
    to come back instead of indexing or dropping the URL.
    """
    return HTMLResponse(
        "<!doctype html><html><head><meta name=\"robots\" content=\"noindex\"></head>"
        "<body>Temporarily unavailable</body></html>",
        status_code=503,
        headers={"Retry-After": "300", "Cache-Control": "no-store"},
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
async def og_proposal(proposal_id: str, request: Request) -> HTMLResponse:
    url = f"{SITE_BASE}/proposal/{proposal_id}"
    # /proposal/new is the composer, which this route shadows before the
    # catch-all can see it. It exists, it is just not content.
    if proposal_id == "new":
        return HTMLResponse(
            _render(title=DEFAULT_TITLE, description=DEFAULT_DESCRIPTION, url=url,
                    body="", robots=NOINDEX),
            headers={"Cache-Control": "public, max-age=3600"},
        )
    try:
        UUID(proposal_id)
        where_clause = "id = {id:UUID}"
        params = {"id": proposal_id}
    except (ValueError, AttributeError):
        # Fall back to short_id lookup. Validate shape to avoid arbitrary
        # inputs bombing the query — 6-char [a-z0-9] only.
        if len(proposal_id) != 6 or not all(
            c in "abcdefghijklmnopqrstuvwxyz0123456789" for c in proposal_id
        ):
            return _not_found()
        where_clause = "short_id = {sid:String}"
        params = {"sid": proposal_id}
    try:
        row = await _proposal_row(where_clause, params)
    except Exception as e:
        logger.warning("og proposal %s: %s", proposal_id, e)
        return _unavailable()
    if not row:
        return _not_found()

    title = (row.get("title") or "").strip() or DEFAULT_TITLE
    summary = (row.get("summary") or "").strip()
    # The facts the preview card shows, ahead of the summary.
    closed = og_images.proposal_closed(row)
    facts = []
    if row.get("closes_at"):
        facts.append(f"{'Closed' if closed else 'Open until'} {og_images._when(row['closes_at'])}")
    else:
        facts.append("Closed" if closed else "Open")
    usdt = int(row.get("requested_amount_usdt") or 0)
    gnk = int(row.get("requested_amount_gnk") or 0)
    if usdt:
        facts.append(f"requests {usdt:,} USDT")
    if gnk:
        facts.append(f"requests {gnk:,} GNK")
    if row.get("creator_name"):
        facts.append(f"by {row['creator_name']}")
    desc = " · ".join(facts) + ". " + (summary or DEFAULT_DESCRIPTION)
    body_text = (row.get("description") or "").strip()
    body = (
        f"<h1>{html.escape(title)}</h1>"
        f"<p>{html.escape(_short(summary, 320))}</p>"
        f"<div>{html.escape(_short(body_text, 1500))}</div>"
    )
    slug = row.get("short_id") or str(row["id"])
    return HTMLResponse(
        _render(title=title, description=_short(desc, 200), url=url, body=body,
                image=f"{SITE_BASE}/api/og/proposal/{slug}.png"),
        headers={"Cache-Control": "public, max-age=300"},
    )


async def _proposal_row(where_clause: str, params: dict) -> Optional[dict]:
    """A community proposal with what its page and preview card show."""
    ch = _ensure_ch()
    return await ch.query_one(
        f"""
        SELECT t.id AS id, t.short_id AS short_id, t.title AS title,
               t.summary AS summary, t.description AS description,
               t.status AS status, t.created_at AS created_at, t.closes_at AS closes_at,
               toUInt64(t.requested_amount_usdt) AS requested_amount_usdt,
               toUInt64(t.requested_amount_gnk) AS requested_amount_gnk,
               u.name AS creator_name
        FROM gonka_vote.proposals AS t FINAL
        LEFT JOIN gonka_vote.users AS u FINAL ON u.email = t.creator_email
        WHERE t.{where_clause} AND t.deleted_at IS NULL
        """,
        params,
    )


async def _proposal_weights(proposal_id: str) -> dict:
    """GNK weight behind the likes and dislikes of one proposal, as the
    proposal list computes it (router._REACTIONS_CTE)."""
    ch = _ensure_ch()
    row = await ch.query_one(
        """
        WITH uid_weights AS (
            SELECT account_uid, sum(balance_ngonka) AS weight
            FROM gonka_vote.wallet_links FINAL
            WHERE unlinked_at IS NULL
            GROUP BY account_uid
        )
        SELECT toString(sumIf(COALESCE(w.weight, toUInt128(0)), r.reaction_type = 'like'))    AS likes_weight,
               toString(sumIf(COALESCE(w.weight, toUInt128(0)), r.reaction_type = 'dislike')) AS dislikes_weight
        FROM gonka_vote.proposal_reactions AS r FINAL
        LEFT JOIN uid_weights AS w ON w.account_uid = r.reactor_uid
        WHERE r.proposal_id = {id:UUID} AND r.reaction_type != ''
        """,
        {"id": proposal_id},
    )
    return row or {}


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
        _render(title=title, description=desc, url=url, body="".join(body_lines),
                image=GOVERNANCE_IMAGE),
        headers={"Cache-Control": "public, max-age=300"},
    )


@og_router.get("/governance/{proposal_id:int}", response_class=HTMLResponse)
async def og_governance_proposal(proposal_id: int, request: Request) -> HTMLResponse:
    url = f"{SITE_BASE}/governance/{proposal_id}"
    try:
        ch = _ensure_ch()
        row = await ch.query_one(
            """
            SELECT proposal_id, title, summary, status, proposer, msg_types,
                   submit_time, voting_end_time,
                   yes_count, no_count, abstain_count, veto_count
            FROM gonka_vote.gov_proposals FINAL
            WHERE proposal_id = {pid:UInt32}
            """,
            {"pid": proposal_id},
        )
    except Exception as e:
        logger.warning("og gov proposal %s: %s", proposal_id, e)
        return _unavailable()
    if not row:
        return _not_found()

    raw_title = (row.get("title") or "").strip() or f"Proposal #{proposal_id}"
    title = f"#{proposal_id} {raw_title} — Gonka Governance"
    summary = (row.get("summary") or "").strip()
    desc = _gov_facts(row) + " " + (summary or DEFAULT_DESCRIPTION)
    body = (
        f"<h1>#{proposal_id} {html.escape(raw_title)}</h1>"
        f"<p><strong>Status:</strong> {html.escape(row.get('status') or '')} · "
        f"<strong>Proposer:</strong> {html.escape(row.get('proposer') or '')}</p>"
        f"<div>{html.escape(_short(summary, 1500))}</div>"
    )
    return HTMLResponse(
        _render(title=title, description=_short(desc, 200), url=url, body=body,
                image=f"{SITE_BASE}/api/og/governance/{proposal_id}.png"),
        headers={"Cache-Control": "public, max-age=300"},
    )


def _gov_facts(row: dict) -> str:
    """Status line for a governance proposal's preview, as on its card: no
    live tally (it goes stale in a shared link), the final one once decided."""
    st = (row.get("status") or "").lower()
    if st == "voting":
        lead = (f"Voting until {og_images._when(row['voting_end_time'])}."
                if row.get("voting_end_time") else "Voting.")
        names = list(dict.fromkeys(og_images._msg_badge(t).title() for t in row.get("msg_types") or []))
        if names:
            lead += " Would execute: " + ", ".join(names[:3]) + ("…" if len(names) > 3 else "") + "."
        return lead
    counts = [int(row.get(k) or 0) for k in ("yes_count", "no_count", "abstain_count", "veto_count")]
    cast = sum(counts)
    if st in ("passed", "rejected", "failed") and cast > 0:
        y, n, a, v = (f"{100 * c / cast:.1f}%" for c in counts)
        return f"{st.title()}: yes {y}, no {n}, abstain {a}, veto {v}."
    return f"{st.title() or 'Proposal'}."


# ----------------------------------------------------------------------------
# Preview images for proposals (og_images.py). Under /api so Traefik sends
# every request here, crawler or not.
# ----------------------------------------------------------------------------

def _png(data: bytes, ttl: float) -> Response:
    return Response(data, media_type="image/png",
                    headers={"Cache-Control": f"public, max-age={int(min(ttl, 86400))}"})


@og_router.get("/api/og/proposal/{proposal_id}.png", include_in_schema=False)
async def og_image_proposal(proposal_id: str):
    try:
        UUID(proposal_id)
        where_clause, params = "id = {id:UUID}", {"id": proposal_id}
    except (ValueError, AttributeError):
        if len(proposal_id) != 6 or not all(
            c in "abcdefghijklmnopqrstuvwxyz0123456789" for c in proposal_id
        ):
            return RedirectResponse(SITE_IMAGE, status_code=302)
        where_clause, params = "short_id = {sid:String}", {"sid": proposal_id}

    async def make() -> bytes:
        row = await _proposal_row(where_clause, params)
        if not row:
            raise LookupError(proposal_id)
        row = dict(row)
        if og_images.proposal_closed(row):
            row.update(await _proposal_weights(str(row["id"])))
        return await og_images.card_proposal(row)

    try:
        data = await og_images.cached(f"proposal/{proposal_id}", og_images.TTL_LIVE, make)
    except Exception as e:
        if not isinstance(e, LookupError):
            logger.warning("og image proposal %s: %s", proposal_id, e)
        return RedirectResponse(SITE_IMAGE, status_code=302)
    return _png(data, og_images.TTL_LIVE)


@og_router.get("/api/og/governance/{proposal_id:int}.png", include_in_schema=False)
async def og_image_governance(proposal_id: int):
    async def make() -> bytes:
        row = await _ensure_ch().query_one(
            """
            SELECT proposal_id, title, status, msg_types, submit_time, voting_end_time,
                   yes_count, no_count, abstain_count, veto_count
            FROM gonka_vote.gov_proposals FINAL
            WHERE proposal_id = {pid:UInt32}
            """,
            {"pid": proposal_id},
        )
        if not row:
            raise LookupError(proposal_id)
        return await og_images.card_governance(dict(row))

    try:
        data = await og_images.cached(f"governance/{proposal_id}", og_images.TTL_LIVE, make)
    except Exception as e:
        if not isinstance(e, LookupError):
            logger.warning("og image governance %s: %s", proposal_id, e)
        return RedirectResponse(GOVERNANCE_IMAGE, status_code=302)
    return _png(data, og_images.TTL_LIVE)


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
            SELECT id, short_id, COALESCE(updated_at, created_at) AS lastmod
            FROM gonka_vote.proposals FINAL
            WHERE deleted_at IS NULL
            ORDER BY lastmod DESC
            LIMIT 5000
            """
        ):
            lm = r["lastmod"]
            iso = lm.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(lm, datetime) else now_iso
            slug = r.get("short_id") or r["id"]
            urls.append(_u(f"{SITE_BASE}/proposal/{slug}", iso, "0.7", "daily"))

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


# ----------------------------------------------------------------------------
# robots.txt — served here rather than as a static file so the Sitemap line
# can be absolute: the sitemaps.org protocol requires a fully qualified URL,
# and only the backend knows the deployment's public origin
# (PUBLIC_BASE_URL). A static file would have to hard-code one site's domain.
# ----------------------------------------------------------------------------

_AI_TRAINING_CRAWLERS = (
    "GPTBot",
    "ClaudeBot",
    "Google-Extended",
    "anthropic-ai",
    "CCBot",
    "Bytespider",
    "meta-externalagent",
    "Amazonbot",
    "Applebot-Extended",
    "PerplexityBot",
)


@og_router.get("/robots.txt", include_in_schema=False)
async def robots_txt() -> PlainTextResponse:
    lines = [
        "# Default: allow all crawlers everywhere.",
        "User-agent: *",
        "Allow: /",
        "",
        "# Block AI training crawlers (we still allow Googlebot/Bingbot/etc.).",
    ]
    for agent in _AI_TRAINING_CRAWLERS:
        lines += [f"User-agent: {agent}", "Disallow: /", ""]
    lines.append(f"Sitemap: {SITE_BASE}/sitemap.xml")
    return PlainTextResponse(
        "\n".join(lines) + "\n",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ----------------------------------------------------------------------------
# Static pages and member profiles. Crawlers used to get these from the SPA
# shell, whose canonical is "/" on every path, so each of them declared itself
# a duplicate of the homepage.
# ----------------------------------------------------------------------------

@og_router.get("/privacy", response_class=HTMLResponse)
async def og_privacy() -> HTMLResponse:
    url = f"{SITE_BASE}/privacy"
    return HTMLResponse(
        _render(
            title="Privacy Policy — Gonka Vote",
            description="How Gonka Vote collects, uses and stores personal data.",
            url=url,
            body=f"<h1>Privacy Policy</h1><p><a href=\"{html.escape(url)}\">Gonka Vote privacy policy</a></p>",
        ),
        headers={"Cache-Control": "public, max-age=3600"},
    )


@og_router.get("/terms", response_class=HTMLResponse)
async def og_terms() -> HTMLResponse:
    url = f"{SITE_BASE}/terms"
    return HTMLResponse(
        _render(
            title="Terms of Service — Gonka Vote",
            description="The terms that govern use of Gonka Vote.",
            url=url,
            body=f"<h1>Terms of Service</h1><p><a href=\"{html.escape(url)}\">Gonka Vote terms of service</a></p>",
        ),
        headers={"Cache-Control": "public, max-age=3600"},
    )


@og_router.get("/u/{uid}", response_class=HTMLResponse)
async def og_profile(uid: str) -> HTMLResponse:
    # No database lookup: the users table also holds e-mail addresses, and a
    # profile adds little a search result needs. noindex keeps member
    # activity out of search while "follow" still passes the proposal links.
    url = f"{SITE_BASE}/u/{uid}"
    return HTMLResponse(
        _render(
            title="Member profile — Gonka Vote",
            description=DEFAULT_DESCRIPTION,
            url=url,
            body="<h1>Member profile</h1>",
            robots=NOINDEX,
        ),
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ----------------------------------------------------------------------------
# Everything else a crawler asks for. Must stay the LAST route in this module,
# and og_router must stay the last router in app.py: a catch-all registered
# earlier would shadow every route after it.
# ----------------------------------------------------------------------------

# SPA screens that exist but are app UI, not content.
_APP_SCREENS = {"me", "proposal/new"}


@og_router.get("/{path:path}", include_in_schema=False)
async def og_fallback(path: str):
    # A trailing slash lands here before FastAPI's own slash redirect can
    # run, so /terms/ would 404. Send it to the canonical form instead and
    # let the real route answer.
    if path.endswith("/") and path.strip("/"):
        return RedirectResponse(f"/{path.strip('/')}", status_code=301)
    path = path.strip("/")
    # Mirror the SPA's permanent /tenders -> /proposal redirects so crawlers
    # routed here get the same 301 browsers get from nginx.
    if path == "tenders":
        return RedirectResponse("/", status_code=301)
    if path == "tenders/new":
        return RedirectResponse("/proposal/new", status_code=301)
    if path.startswith("tenders/"):
        return RedirectResponse(f"/proposal/{path[len('tenders/'):]}", status_code=301)
    if path in _APP_SCREENS:
        url = f"{SITE_BASE}/{path}"
        return HTMLResponse(
            _render(title=DEFAULT_TITLE, description=DEFAULT_DESCRIPTION, url=url,
                    body="", robots=NOINDEX),
            headers={"Cache-Control": "public, max-age=3600"},
        )
    # No database work here: crawlers probing junk URLs must not load the
    # database.
    return _not_found()
