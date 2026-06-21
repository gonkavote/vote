"""Sign-in (Google OAuth + Telegram Login Widget) + signed-cookie session.

Flow:
  GET  /api/auth/login       → 302 to Google
  GET  /api/auth/callback    → exchange code, set HttpOnly cookie, 302 home
  POST /api/auth/telegram    → verify TG widget hash, set cookie, 204
  POST /api/auth/logout      → clear cookie
  GET  /api/me               → current user (200 / 401)
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
import uuid
from typing import Any, Optional

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, URLSafeSerializer

from backend.ch import CHClient
from backend.settings import settings

logger = logging.getLogger(__name__)

COOKIE_NAME = "gonka_vote_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.google_client_id,
    client_secret=settings.google_client_secret,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

_serializer = URLSafeSerializer(settings.session_secret, salt="gonka-vote-session")

router = APIRouter(prefix="/auth", tags=["auth"])

# Set from app.py at startup so handlers can reach the DB without DI gymnastics.
_ch: CHClient | None = None


def set_ch(ch: CHClient) -> None:
    global _ch
    _ch = ch


def _ensure_ch() -> CHClient:
    if _ch is None:
        raise RuntimeError("auth module not initialized — call set_ch() at startup")
    return _ch


def _make_session(email: str) -> str:
    return _serializer.dumps({"email": email, "iat": int(time.time())})


def _read_session(token: str | None) -> Optional[dict]:
    if not token:
        return None
    try:
        data = _serializer.loads(token)
        if not isinstance(data, dict) or "email" not in data:
            return None
        return data
    except BadSignature:
        return None


def _new_uid() -> str:
    """Generate 'u_xxxxxxxx' — 8 hex chars from a fresh UUID."""
    return "u_" + uuid.uuid4().hex[:8]


async def current_user_optional(request: Request) -> Optional[dict]:
    """Return user dict {uid, email, name, image, wallet_address, is_admin} or None."""
    sess = _read_session(request.cookies.get(COOKIE_NAME))
    if not sess:
        return None
    ch = _ensure_ch()
    return await ch.query_one(
        """
        SELECT uid, email, name, image, wallet_address, is_admin
        FROM gonka_vote.users FINAL
        WHERE email = {email:String}
        """,
        {"email": sess["email"]},
    )


async def current_admin(request: Request) -> dict:
    """Dependency that 401s if not signed in, 403s if not an admin."""
    user = await current_user_optional(request)
    if not user:
        raise HTTPException(status_code=401, detail="not authenticated")
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="admin only")
    return user


async def current_user(request: Request) -> dict:
    user = await current_user_optional(request)
    if not user:
        raise HTTPException(status_code=401, detail="not authenticated")
    return user


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------

@router.get("/login")
async def login(request: Request, redirect: str = "/"):
    # `redirect` is preserved through the round-trip via a one-time state nonce.
    redirect_uri = f"{settings.public_base_url.rstrip('/')}/api/auth/callback"
    request.session["oauth_redirect"] = redirect
    return await oauth.google.authorize_redirect(request, redirect_uri)


async def _upsert_user(
    *,
    email: str,
    name: Optional[str],
    image: Optional[str],
) -> None:
    """Idempotent upsert via ReplacingMergeTree(updated_at).

    Preserves uid, wallet_address and is_admin across re-logins; mints a
    fresh uid the first time we see this email.
    """
    ch = _ensure_ch()
    existing = await ch.query_one(
        """
        SELECT uid, wallet_address, is_admin, notifications_disabled
        FROM gonka_vote.users FINAL
        WHERE email = {email:String}
        """,
        {"email": email},
    )
    existing = existing or {}
    uid = existing.get("uid") or _new_uid()
    await ch.insert(
        "users",
        ["email", "name", "image", "wallet_address", "uid", "is_admin",
         "notifications_disabled"],
        [[
            email, name, image,
            existing.get("wallet_address"),
            uid,
            bool(existing.get("is_admin")),
            bool(existing.get("notifications_disabled")),
        ]],
    )


def _attach_session_cookie(response: Response, email: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        _make_session(email),
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        domain=settings.cookie_domain,
        path="/",
    )


@router.get("/callback")
async def callback(request: Request):
    try:
        token = await oauth.google.authorize_access_token(request)
    except Exception as e:
        logger.warning("oauth callback failed: %s", e)
        raise HTTPException(status_code=400, detail="oauth failed")

    info = token.get("userinfo")
    if not info or "email" not in info:
        raise HTTPException(status_code=400, detail="missing email")

    email = info["email"].lower()
    await _upsert_user(
        email=email,
        name=info.get("name"),
        image=info.get("picture"),
    )

    redirect_to = request.session.pop("oauth_redirect", "/")
    response = RedirectResponse(url=redirect_to, status_code=302)
    _attach_session_cookie(response, email)
    return response


# ---------------------------------------------------------------------------
# Telegram Login Widget
# ---------------------------------------------------------------------------

# How long the auth_date returned by Telegram is allowed to be valid for —
# protects against replay-attacks with an old hash that's been leaked.
TELEGRAM_AUTH_TTL = 24 * 60 * 60  # 24 hours, per Telegram docs


def verify_telegram_signature(payload: dict[str, Any], bot_token: str) -> bool:
    """HMAC-SHA256 check per https://core.telegram.org/widgets/login#checking-authorization.

    Builds a data-check-string from every field except `hash`, sorted
    alphabetically, joined as `key=value` separated by '\n'. The secret
    key is sha256(bot_token). Returns True iff the hex digest matches
    the supplied `hash`. Constant-time comparison.
    """
    if not bot_token:
        return False
    received_hash = payload.get("hash")
    if not isinstance(received_hash, str):
        return False
    pairs = sorted(
        (k, str(v)) for k, v in payload.items() if k != "hash" and v is not None
    )
    data_check_string = "\n".join(f"{k}={v}" for k, v in pairs)
    secret_key = hashlib.sha256(bot_token.encode()).digest()
    expected = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, received_hash.lower())


@router.post("/telegram")
async def telegram_login(payload: dict[str, Any] = Body(...)) -> Response:
    if not settings.telegram_bot_token:
        raise HTTPException(status_code=503, detail="telegram login disabled")

    if not verify_telegram_signature(payload, settings.telegram_bot_token):
        raise HTTPException(status_code=401, detail="bad telegram signature")

    try:
        auth_date = int(payload.get("auth_date", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid auth_date")
    if auth_date <= 0 or time.time() - auth_date > TELEGRAM_AUTH_TTL:
        raise HTTPException(status_code=401, detail="auth_date too old")

    tg_id = payload.get("id")
    if not isinstance(tg_id, int):
        # FastAPI parses ints for us, but the request may send a string.
        try:
            tg_id = int(tg_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="missing telegram id")

    first_name = (payload.get("first_name") or "").strip() or None
    last_name = (payload.get("last_name") or "").strip() or None
    username = (payload.get("username") or "").strip() or None
    photo_url = (payload.get("photo_url") or "").strip() or None

    if first_name and last_name:
        display_name: Optional[str] = f"{first_name} {last_name}"
    elif first_name:
        display_name = first_name
    elif username:
        display_name = f"@{username}"
    else:
        display_name = None

    email = f"tg:{tg_id}@telegram.local"
    await _upsert_user(email=email, name=display_name, image=photo_url)
    # Build the response ourselves so set_cookie actually lands in the
    # outgoing headers (the magic `response` injected by FastAPI is only
    # honoured when we return a non-Response value).
    response = Response(status_code=204)
    _attach_session_cookie(response, email)
    return response


@router.post("/logout")
async def logout():
    response = RedirectResponse(url="/", status_code=303)
    response.delete_cookie(COOKIE_NAME, path="/", domain=settings.cookie_domain)
    return response
