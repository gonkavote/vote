"""POST /api/telegram/webhook — receives Bot API updates.

Only handles `/stop` (opt out of notifications) and `/start` (opt back in)
in private chats. Other updates are acked but ignored. The header
`X-Telegram-Bot-Api-Secret-Token` must match `settings.telegram_webhook_secret`
— without that, we return 401 so random internet traffic can't toggle flags.

Bot ack messages are sent best-effort: a sendMessage failure does NOT roll
back the opt-out — the user may have blocked the bot, in which case we still
want their preference recorded.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

from backend.auth import _ensure_ch
from backend.notifications import set_user_opt_out
from backend.notifier.telegram_client import send_message
from backend.settings import settings

logger = logging.getLogger(__name__)

telegram_webhook_router = APIRouter(prefix="/telegram", tags=["telegram"])


@telegram_webhook_router.post("/webhook")
async def webhook(
    request: Request,
    x_telegram_bot_api_secret_token: Optional[str] = Header(default=None),
):
    if not settings.telegram_webhook_secret:
        raise HTTPException(503, "webhook disabled")
    if x_telegram_bot_api_secret_token != settings.telegram_webhook_secret:
        raise HTTPException(401, "bad secret")

    update = await request.json()
    msg = update.get("message") or update.get("edited_message")
    if not isinstance(msg, dict):
        return {"ok": True}

    text = (msg.get("text") or "").strip().lower()
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if not isinstance(chat_id, int):
        return {"ok": True}

    email = f"tg:{chat_id}@telegram.local"
    ch = _ensure_ch()

    if text.startswith("/stop"):
        try:
            updated = await set_user_opt_out(ch, email, True)
        except Exception as e:
            logger.warning("/stop opt-out for %s failed: %s", email, e)
            return {"ok": True}
        if updated:
            logger.info("user %s opted OUT of notifications", email)
        try:
            await send_message(
                chat_id,
                "Notifications disabled. Send /start to re-enable.",
            )
        except Exception as e:
            logger.info("ack to %s failed (non-fatal): %s", email, e)
    elif text.startswith("/start"):
        try:
            updated = await set_user_opt_out(ch, email, False)
        except Exception as e:
            logger.warning("/start opt-in for %s failed: %s", email, e)
            return {"ok": True}
        if updated:
            logger.info("user %s opted IN to notifications", email)
        try:
            await send_message(
                chat_id,
                "Notifications enabled. Reply /stop to disable.",
            )
        except Exception as e:
            logger.info("ack to %s failed (non-fatal): %s", email, e)

    return {"ok": True}
