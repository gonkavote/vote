"""SMTP client for Gmail. Runs the blocking smtplib call in a thread so it
doesn't block the notifier's asyncio loop."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import smtplib
import ssl
from email.message import EmailMessage
from html import escape as h
from typing import Optional

from backend.settings import settings

logger = logging.getLogger(__name__)


class EmailError(Exception):
    """Raised when SMTP delivery fails permanently or transiently. `retryable`
    tells the worker whether to reschedule the job."""

    def __init__(self, description: str, *, retryable: bool):
        super().__init__(description)
        self.description = description
        self.retryable = retryable


def unsubscribe_token(email: str) -> str:
    """Deterministic per-email HMAC. Kept short via URL-safe base64 of the
    first 16 bytes — collision-resistant enough for this narrow use."""
    secret = settings.unsubscribe_secret or settings.session_secret
    mac = hmac.new(secret.encode("utf-8"), email.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac[:16]).rstrip(b"=").decode("ascii")


def verify_unsubscribe_token(email: str, token: str) -> bool:
    return hmac.compare_digest(unsubscribe_token(email), token or "")


def build_unsubscribe_url(email: str) -> str:
    from urllib.parse import quote

    base = settings.public_base_url.rstrip("/")
    return f"{base}/api/unsubscribe?email={quote(email)}&token={unsubscribe_token(email)}"


def _render_html(*, subject: str, body_text: str, link: str, unsub_url: str) -> str:
    """Minimal, safe HTML with inline styles (many email clients strip <style>)."""
    return f"""\
<!doctype html>
<html><body style="margin:0;padding:0;background:#0e0e16;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f0f0f5;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0e0e16;padding:32px 0;">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181822;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:#ffffff;">{h(subject)}</h1>
        <div style="font-size:15px;line-height:1.6;color:#c8c8d0;white-space:pre-wrap;">{h(body_text)}</div>
        <div style="margin:24px 0;">
          <a href="{h(link)}"
             style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;
                    padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">
            Open on Gonka Vote
          </a>
        </div>
        <hr style="border:none;border-top:1px solid #2a2a38;margin:24px 0;">
        <div style="font-size:12px;line-height:1.5;color:#8e8ea1;">
          You are receiving this because you have an account on
          <a href="{h(settings.public_base_url.rstrip('/'))}" style="color:#8e8ea1;">gonka.vote</a>.<br>
          <a href="{h(unsub_url)}" style="color:#8e8ea1;">Unsubscribe from all email notifications</a>.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>
"""


def _render_text(*, body_text: str, link: str, unsub_url: str) -> str:
    return (
        f"{body_text}\n\n"
        f"Open on Gonka Vote: {link}\n\n"
        f"—\n"
        f"Unsubscribe from all email notifications: {unsub_url}\n"
    )


async def send_email(
    *,
    to: str,
    subject: str,
    body_text: str,
    link: str,
) -> None:
    """Send one email. Raises EmailError on failure."""
    if not settings.smtp_host or not settings.smtp_user or not settings.smtp_password:
        raise EmailError("SMTP is not configured", retryable=False)

    unsub_url = build_unsubscribe_url(to)
    from_addr = settings.smtp_from or settings.smtp_user

    msg = EmailMessage()
    msg["From"] = f"Gonka Vote <{from_addr}>"
    msg["To"] = to
    msg["Subject"] = subject
    # RFC 8058 one-click header — Gmail shows an in-inbox "Unsubscribe" link.
    msg["List-Unsubscribe"] = f"<{unsub_url}>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(_render_text(body_text=body_text, link=link, unsub_url=unsub_url))
    msg.add_alternative(
        _render_html(subject=subject, body_text=body_text, link=link, unsub_url=unsub_url),
        subtype="html",
    )

    def _blocking_send() -> None:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as s:
            s.ehlo()
            s.starttls(context=ctx)
            s.ehlo()
            s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg)

    try:
        await asyncio.to_thread(_blocking_send)
    except smtplib.SMTPRecipientsRefused as e:
        # Bad address: permanent, no point retrying.
        raise EmailError(f"recipient refused: {e}", retryable=False)
    except smtplib.SMTPAuthenticationError as e:
        raise EmailError(f"auth failed: {e}", retryable=False)
    except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError,
            TimeoutError, OSError) as e:
        # Transient network/server: retryable.
        raise EmailError(f"transient smtp: {e}", retryable=True)
    except smtplib.SMTPException as e:
        raise EmailError(f"smtp: {e}", retryable=True)
    except Exception as e:
        raise EmailError(f"unexpected: {e}", retryable=True)
