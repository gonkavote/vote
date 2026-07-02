import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from backend.auth import router as auth_router, set_ch
from backend.ch import CHClient
from backend.governance.poller import run_poller as run_governance_poller
from backend.governance.router import gov_router
from backend.og import og_router
from backend.router import router as api_router
from backend.settings import settings, validate_required
from backend.telegram_webhook import telegram_webhook_router

logging.basicConfig(
    level=settings.log_level,
    format="%(levelname)s:     %(message)s",
)
logger = logging.getLogger(__name__)


_missing = validate_required()
if _missing:
    # Don't import-fail — that hides the message inside uvicorn's
    # ImportError. Log loud, then let the app boot to expose the cause
    # via /api/health (which won't return anything useful, but the
    # operator will see the log line above).
    logger.error(
        "missing required settings: %s — see .env.template", ", ".join(_missing),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    ch = CHClient(
        host=settings.clickhouse_host,
        port=settings.clickhouse_http_port,
        database=settings.clickhouse_database,
        username=settings.clickhouse_user,
        password=settings.clickhouse_password,
    )
    await ch.connect()
    set_ch(ch)
    logger.info("backend ready (CH only)")
    poller_task = asyncio.create_task(
        run_governance_poller(ch), name="governance-poller",
    )
    # Register the Telegram webhook once at startup when all the pieces are
    # configured. Done inline (not via create_task) so the result lands in
    # the startup log — a fire-and-forget task without a done-callback would
    # swallow any failure silently.
    if (
        settings.telegram_bot_token
        and settings.telegram_webhook_secret
        and settings.public_base_url.startswith("https://")
    ):
        from backend.notifier.telegram_client import set_webhook
        webhook_url = (
            f"{settings.public_base_url.rstrip('/')}/api/telegram/webhook"
        )
        try:
            await set_webhook(webhook_url, settings.telegram_webhook_secret)
            logger.info("telegram webhook registered at %s", webhook_url)
        except Exception as e:
            # Don't crash the API just because the bot can't be reached —
            # notifications will still send; only /stop is broken.
            logger.warning("set_webhook failed at startup: %s", e)
    else:
        logger.info(
            "telegram webhook not registered: missing token=%s, secret=%s, https=%s",
            bool(settings.telegram_bot_token),
            bool(settings.telegram_webhook_secret),
            settings.public_base_url.startswith("https://"),
        )
    try:
        yield
    finally:
        poller_task.cancel()
        try:
            await poller_task
        except (asyncio.CancelledError, Exception):
            pass
        await ch.close()
        logger.info("shutdown complete")


app = FastAPI(title="Gonka Vote Backend", lifespan=lifespan)

# Session middleware is required by Authlib for the OAuth state cookie. This is
# a *separate* short-lived cookie from our long-lived session cookie set in
# auth.callback().
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    same_site="lax",
    https_only=settings.cookie_secure,
    max_age=600,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth router is mounted under /api/auth so traefik /api strip works the same
# as the rest of the API.
app.include_router(auth_router, prefix="/api")
app.include_router(api_router)
app.include_router(gov_router)
app.include_router(telegram_webhook_router, prefix="/api")
# Bot-only OG/Twitter card SSR for /proposal/{id}. Traefik routes
# crawler user-agents here; real browsers go straight to the SPA.
app.include_router(og_router)
