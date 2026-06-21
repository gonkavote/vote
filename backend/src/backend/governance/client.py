"""Async client for tracker.gonka.vip's public governance JSON API.

Thin httpx wrapper. Returns parsed dicts (not Pydantic) — the cache layer
turns those into our DB rows. We keep failures noisy: any HTTP error or
JSON parse error bubbles up; the caller decides whether to fall back to
stale cache.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from backend.settings import settings

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_client: Optional[httpx.AsyncClient] = None


def _http() -> httpx.AsyncClient:
    """Lazy-init singleton; reused across the poller and lazy-refresh paths."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=settings.tracker_api_url.rstrip("/"),
            timeout=_DEFAULT_TIMEOUT,
            headers={"User-Agent": "vote-backend/governance-cache"},
        )
    return _client


async def list_proposals(
    *,
    status: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if status:
        params["status"] = status
    if search:
        params["search"] = search
    r = await _http().get("/governance/proposals", params=params)
    r.raise_for_status()
    return r.json()


async def get_proposal(proposal_id: int) -> dict[str, Any]:
    r = await _http().get(f"/governance/proposals/{proposal_id}")
    r.raise_for_status()
    return r.json()


async def list_votes(proposal_id: int, *, page_size: int = 500) -> list[dict[str, Any]]:
    r = await _http().get(
        f"/governance/proposals/{proposal_id}/votes",
        params={"page": 1, "page_size": page_size},
    )
    r.raise_for_status()
    return r.json()


async def list_deposits(proposal_id: int) -> list[dict[str, Any]]:
    r = await _http().get(f"/governance/proposals/{proposal_id}/deposits")
    r.raise_for_status()
    return r.json()


async def get_metadata(proposal_id: int) -> Optional[dict[str, Any]]:
    """Returns None if the proposal has no fetchable metadata (404)."""
    r = await _http().get(f"/governance/proposals/{proposal_id}/metadata")
    if r.status_code == 404:
        return None
    r.raise_for_status()
    body = r.json()
    # Tracker returns {"detail": "..."} on "not a fetchable URL" with 200.
    if isinstance(body, dict) and "markdown" not in body:
        return None
    return body


async def get_params() -> dict[str, Any]:
    r = await _http().get("/governance/params")
    r.raise_for_status()
    return r.json()
