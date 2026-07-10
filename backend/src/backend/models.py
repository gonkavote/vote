from datetime import datetime, timezone
from typing import Annotated, Optional
from uuid import UUID

from pydantic import BaseModel, Field, PlainSerializer, field_validator


def _isoformat_utc(dt: Optional[datetime]) -> Optional[str]:
    """Serialize datetime as ISO 8601 UTC with explicit 'Z' suffix.

    ClickHouse stores DateTime64('UTC') but clickhouse-connect returns naive
    datetimes. We treat naive values as UTC (which is true for our schema) so
    that browsers parse them as UTC instead of local time.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


# Reusable annotated type for any datetime field we expose.
UtcDateTime = Annotated[datetime, PlainSerializer(_isoformat_utc, return_type=str)]


# ----------------------------------------------------------------------------
# Proposal
# ----------------------------------------------------------------------------

class ProposalCreate(BaseModel):
    title: str = Field(min_length=3, max_length=80)
    summary: str = Field(min_length=10, max_length=200)
    description: str = Field(min_length=1, max_length=20_000)
    closes_at: Optional[datetime] = None
    requested_amount_usdt: int = Field(default=0, ge=0, le=1_000_000_000_000)
    requested_amount_gnk: int = Field(default=0, ge=0, le=1_000_000_000_000)


class ProposalSummary(BaseModel):
    id: UUID
    short_id: str = ""
    title: str
    summary: str = ""
    creator_uid: str
    creator_name: Optional[str] = None
    creator_image: Optional[str] = None
    status: str
    created_at: UtcDateTime
    closes_at: Optional[UtcDateTime] = None
    requested_amount_usdt: int = 0
    requested_amount_gnk: int = 0
    likes_count: int = 0
    dislikes_count: int = 0
    likes_weight_ngonka: str = "0"
    dislikes_weight_ngonka: str = "0"
    my_reaction: Optional[str] = None  # 'like' | 'dislike' | None
    comment_count: int = 0
    source_lang: str = ""
    is_translated: bool = False
    original_title: Optional[str] = None
    original_summary: Optional[str] = None
    translation_status: str = "ready"


class ProposalDetail(ProposalSummary):
    description: str
    creator_wallet: Optional[str] = None
    original_description: Optional[str] = None


class LinkedWallet(BaseModel):
    wallet: str
    balance_ngonka: str = "0"
    linked_at: UtcDateTime
    balance_refreshed_at: Optional[UtcDateTime] = None


# ----------------------------------------------------------------------------
# Comments
# ----------------------------------------------------------------------------

class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=10_000)
    parent_comment_id: Optional[UUID] = None


class CommentOut(BaseModel):
    id: UUID
    author_uid: str
    author_name: Optional[str] = None
    author_image: Optional[str] = None
    body: str
    created_at: UtcDateTime
    parent_comment_id: Optional[UUID] = None
    likes: int = 0
    dislikes: int = 0
    my_reaction: Optional[str] = None  # 'like' | 'dislike' | None
    source_lang: str = ""
    is_translated: bool = False
    original_body: Optional[str] = None
    translation_status: str = "ready"


class ReactionUpsert(BaseModel):
    reaction: str = Field(pattern="^(like|dislike|)$")  # '' = remove


# ----------------------------------------------------------------------------
# User
# ----------------------------------------------------------------------------

class UserOut(BaseModel):
    """Private — returned only from /api/me. Includes email."""
    uid: str
    email: str
    name: Optional[str] = None
    image: Optional[str] = None
    wallet_address: Optional[str] = None
    is_admin: bool = False


class UserPublicProfile(BaseModel):
    """Public — returned from /api/users/{uid}. Email is intentionally absent."""
    uid: str
    name: Optional[str] = None
    image: Optional[str] = None
    wallet_address: Optional[str] = None
    total_weight_ngonka: str = "0"
    linked_wallets_count: int = 0
    proposals: list[ProposalSummary] = []


class UserUpdate(BaseModel):
    wallet_address: Optional[str] = None

    @field_validator("wallet_address")
    @classmethod
    def _validate_wallet(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        v = v.strip()
        if not v.startswith("gonka1") or len(v) < 39 or len(v) > 90:
            raise ValueError("must be a gonka1... bech32 address")
        return v
