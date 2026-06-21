"""Thin httpx wrapper around the Telegram Bot API.

No third-party Telegram SDK — we already use httpx everywhere else and
only call sendMessage / setWebhook / deleteWebhook.

`TelegramError.error_code` is the Bot API's own code (forbidden=403,
bad_request=400, etc) which we propagate so the worker can branch on it.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from backend.settings import settings

logger = logging.getLogger(__name__)

_BASE = "https://api.telegram.org"


class TelegramError(Exception):
    def __init__(
        self,
        *,
        status_code: int,
        error_code: int,
        description: str,
        retry_after: Optional[int] = None,
    ):
        self.status_code = status_code
        self.error_code = error_code
        self.description = description
        self.retry_after = retry_after
        super().__init__(f"{status_code}/{error_code}: {description}")


async def _call(method: str, payload: dict) -> dict:
    token = settings.telegram_bot_token
    if not token:
        raise TelegramError(
            status_code=503,
            error_code=503,
            description="telegram_bot_token not configured",
        )
    url = f"{_BASE}/bot{token}/{method}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            r = await client.post(url, json=payload)
        except httpx.HTTPError as e:
            raise TelegramError(
                status_code=599,
                error_code=599,
                description=f"network error: {e}",
            ) from e
        try:
            data = r.json()
        except ValueError:
            raise TelegramError(
                status_code=r.status_code,
                error_code=r.status_code,
                description=f"non-JSON response: {r.text[:200]}",
            )
        if r.status_code != 200 or not data.get("ok"):
            params = data.get("parameters") or {}
            raise TelegramError(
                status_code=r.status_code,
                error_code=int(data.get("error_code") or r.status_code),
                description=str(data.get("description") or "unknown"),
                retry_after=params.get("retry_after"),
            )
        return data.get("result") or {}


async def send_message(chat_id: int, text: str, *,
                       disable_web_page_preview: bool = False) -> dict:
    """Send a plain-text message. We don't use parse_mode to avoid having
    to escape MarkdownV2 — the message body is user-supplied."""
    return await _call("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": disable_web_page_preview,
    })


async def set_webhook(url: str, secret_token: str) -> dict:
    """Register an HTTPS webhook URL. `secret_token` is echoed by Telegram
    in the X-Telegram-Bot-Api-Secret-Token header on every update."""
    return await _call("setWebhook", {
        "url": url,
        "secret_token": secret_token,
        "allowed_updates": ["message"],
    })


async def delete_webhook() -> dict:
    return await _call("deleteWebhook", {})


async def get_webhook_info() -> dict:
    return await _call("getWebhookInfo", {})
