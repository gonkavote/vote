"""Background task that pulls active governance proposals from tracker.

Runs as a single asyncio.Task inside the FastAPI process (started in
app.py lifespan). One tick:
  1. Pull active (voting + deposit) proposal lists.
  2. For each — upsert into our cache (which fires off translation jobs
     when text changed).
  3. Refresh votes/deposits for active proposals.
  4. Refresh GitHub-hosted metadata for active proposals (rate-limited
     by tracker, so we just trust their cache).
  5. Refresh /governance/params snapshot.

Closed proposals (passed/rejected/failed) are NOT refreshed in the
background; they're pulled on-demand when the user opens a detail page.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from backend.ch import CHClient
from backend.governance import cache, client
from backend.settings import settings

logger = logging.getLogger(__name__)


async def _refresh_one(ch: CHClient, raw: dict[str, Any]) -> None:
    pid = int(raw["proposal_id"])
    # The list_proposals payload is a summary — it lacks `messages` and
    # `metadata`. Fetch the detail to pick those up so upsert doesn't blank
    # them out. If the detail call fails, SKIP upserting the row entirely:
    # upserting from the summary would overwrite the existing messages/
    # metadata with empty strings, which the SPA's JSON tab then renders as
    # `"messages": []`. The next tick (60s later) will retry the detail
    # fetch and write a proper row; votes/deposits/metadata-md below run
    # independently and still refresh.
    try:
        detail = await client.get_proposal(pid)
    except Exception as e:
        logger.warning(
            "get_proposal(%s) failed; skipping upsert this tick to preserve "
            "existing messages/metadata: %s", pid, e,
        )
        detail = None
    if detail is not None:
        # Belt and braces: if the tracker detail comes back with empty
        # messages/metadata for a proposal we already have data for, skip
        # the upsert too. Saw the live tracker briefly return empty
        # messages for proposal 76 after it transitioned to passed; not
        # worth blanking the cache row over it.
        if not detail.get("messages") and not detail.get("metadata"):
            try:
                existing = await ch.query_one(
                    "SELECT length(messages) AS m, length(metadata) AS d "
                    "FROM gonka_vote.gov_proposals FINAL "
                    "WHERE proposal_id = {pid:UInt32}",
                    {"pid": pid},
                )
                if existing and (existing.get("m", 0) > 0 or existing.get("d", 0) > 0):
                    logger.info(
                        "tracker returned empty messages/metadata for proposal %s "
                        "but cache already has them — skipping upsert", pid,
                    )
                    detail = None
            except Exception as e:
                logger.warning("pre-upsert check for %s failed: %s", pid, e)
    if detail is not None:
        try:
            await cache.upsert_proposal(ch, detail)
        except Exception as e:
            logger.warning("upsert_proposal(%s) failed: %s", pid, e)
            return

    try:
        votes = await client.list_votes(pid)
        await cache.upsert_votes(ch, pid, votes)
    except Exception as e:
        logger.warning("votes(%s) refresh failed: %s", pid, e)

    try:
        deposits = await client.list_deposits(pid)
        await cache.upsert_deposits(ch, pid, deposits)
    except Exception as e:
        logger.warning("deposits(%s) refresh failed: %s", pid, e)

    try:
        md = await client.get_metadata(pid)
        if md is not None:
            await cache.upsert_metadata(ch, pid, md)
    except Exception as e:
        logger.warning("metadata(%s) refresh failed: %s", pid, e)


async def tick(ch: CHClient) -> None:
    """One pass over active proposals + params snapshot."""
    seen: set[int] = set()
    for status in ("voting", "deposit"):
        try:
            page = await client.list_proposals(status=status, page_size=100)
        except Exception as e:
            logger.warning("list_proposals(status=%s) failed: %s", status, e)
            continue
        for raw in page.get("proposals", []):
            pid = int(raw["proposal_id"])
            if pid in seen:
                continue
            seen.add(pid)
            await _refresh_one(ch, raw)

    try:
        params = await client.get_params()
        await cache.upsert_params(ch, params)
    except Exception as e:
        logger.warning("params refresh failed: %s", e)

    if seen:
        logger.info("governance tick: refreshed %d active proposal(s)", len(seen))


async def run_poller(ch: CHClient) -> None:
    """Long-running loop. Cancellable; survives transient errors."""
    interval = settings.governance_poll_interval
    logger.info("governance poller: started, interval=%ds", interval)
    # Slight delay so we don't fight cold-start contention with the rest of lifespan.
    await asyncio.sleep(2)
    while True:
        try:
            await tick(ch)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("governance tick crashed: %s", e)
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
