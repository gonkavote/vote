"""Pydantic schemas for /api/governance/*.

Mirrors tracker.gonka.vip's /v1/governance shape but adds the translation
fields that the SPA uses to render with a "Show original" toggle. Status
strings are normalized from the chain's PROPOSAL_STATUS_* enum into the
short forms the UI tabs expect ('voting', 'deposit', 'passed', 'rejected',
'failed').
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel

from backend.models import UtcDateTime


# ----------------------------------------------------------------------------
# Status normalization
# ----------------------------------------------------------------------------

# The chain returns long enum names; the UI tabs use short ones.
_STATUS_MAP = {
    "PROPOSAL_STATUS_DEPOSIT_PERIOD": "deposit",
    "PROPOSAL_STATUS_VOTING_PERIOD": "voting",
    "PROPOSAL_STATUS_PASSED": "passed",
    "PROPOSAL_STATUS_REJECTED": "rejected",
    "PROPOSAL_STATUS_FAILED": "failed",
}


def normalize_status(raw: str) -> str:
    """Map PROPOSAL_STATUS_VOTING_PERIOD → 'voting'. Unknown values pass through."""
    if not raw:
        return ""
    return _STATUS_MAP.get(raw, raw.lower())


# ----------------------------------------------------------------------------
# Proposal (list + detail)
# ----------------------------------------------------------------------------

class GovProposalSummary(BaseModel):
    proposal_id: int
    title: str
    summary: str
    status: str             # 'voting' | 'deposit' | 'passed' | 'rejected' | 'failed'
    expedited: bool = False
    submit_time: UtcDateTime
    voting_start_time: Optional[UtcDateTime] = None
    voting_end_time: Optional[UtcDateTime] = None
    deposit_end_time: Optional[UtcDateTime] = None
    yes_count: str = "0"
    no_count: str = "0"
    abstain_count: str = "0"
    veto_count: str = "0"
    total_deposit_ngonka: str = "0"
    voted_count: int = 0
    depositor_count: int = 0
    total_voters_at_end: int = 0
    total_bonded_at_end: str = "0"
    epoch_at_submit: Optional[int] = None
    msg_types: list[str] = []
    # Translation overlay (filled by `_pick_translation`).
    source_lang: str = ""
    is_translated: bool = False
    original_title: Optional[str] = None
    original_summary: Optional[str] = None
    translation_status: str = "ready"


class GovProposalDetail(GovProposalSummary):
    metadata_url: str = ""
    proposer: str = ""
    failed_reason: str = ""
    original_failed_reason: Optional[str] = None
    # Full decoded message payload from the tracker API. Used by the JSON
    # tab on the frontend. Type is intentionally loose — each message is a
    # heterogeneous proto-decoded object.
    messages: list[Any] = []
    # Optional cosmos governance metadata blob (rare, usually empty).
    metadata: str = ""


class GovProposalsPage(BaseModel):
    proposals: list[GovProposalSummary]
    total: int
    page: int
    page_size: int


# ----------------------------------------------------------------------------
# Votes / deposits / metadata / params
# ----------------------------------------------------------------------------

class GovVote(BaseModel):
    voter: str
    option: str
    weight: float = 0.0
    voting_power: str = "0"
    voted_at: Optional[UtcDateTime] = None
    voted_height: int = 0
    tx_hash: str = ""


class GovDeposit(BaseModel):
    depositor: str
    amount_ngonka: str = "0"
    deposited_at: Optional[UtcDateTime] = None
    tx_hash: str = ""


class GovMetadata(BaseModel):
    proposal_id: int
    markdown: str = ""
    source_url: str = ""
    fetched_at: Optional[UtcDateTime] = None
    is_translated: bool = False
    original_markdown: Optional[str] = None
    translation_status: str = "ready"


class GovParams(BaseModel):
    payload_json: str = "{}"
    fetched_at: Optional[UtcDateTime] = None
