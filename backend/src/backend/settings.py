from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process-wide settings loaded from .env / environment.

    Values that touch infrastructure (chain endpoints, tracker UI, public
    domain, WalletConnect project) are intentionally left WITHOUT defaults
    so an empty .env fails fast at startup instead of running against the
    wrong network. Validate via `validate_required()` in app startup.
    """
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ClickHouse (HTTP port for clickhouse-connect)
    clickhouse_host: str = "clickhouse"
    clickhouse_http_port: int = 8123
    clickhouse_database: str = "gonka_vote"
    clickhouse_user: str = "default"
    clickhouse_password: str = ""

    # Chain endpoints (REQUIRED — no default; deploy-specific).
    #
    # Two pairs because the backend and indexer have different requirements:
    #
    # * Indexer (Go) needs a node with tx_indexer=on AND non-pruned balance
    #   history. It hits /tx_search heavily and /cosmos/bank/.../balances/...
    #   per voter on every snapshot.
    # * Backend proxies user-signed transactions through to the chain
    #   (/api/chain/* → broadcast) and just surfaces the RPC URL to the SPA
    #   for the inferenced-CLI hint. It needs a node that accepts broadcasts
    #   reliably; tx_search support is not used here.
    #
    # Operators with one node that does both can point both pairs at the
    # same URL.
    chain_id: str = ""                  # e.g. "gonka-mainnet"
    # Indexer-facing pair (matches the Go indexer's RPC_URL / CHAIN_API_URL).
    chain_api_url: str = ""             # used here only as a fallback for
                                        # backend_chain_api_url when empty.
    rpc_url: str = ""                   # fallback for backend_rpc_url when empty.
    # Backend-facing pair. If empty, falls back to chain_api_url / rpc_url
    # — so a single-node deployment still works with just RPC_URL +
    # CHAIN_API_URL set in .env.
    backend_chain_api_url: str = ""     # used by the /api/chain proxy
    backend_rpc_url: str = ""           # exposed in /api/config for the SPA's
                                        # CLI hint ("--node <url>")
    contract_address: str = ""
    link_contract_address: str = ""

    # Internal URL of the indexer's HTTP server (health + /refresh). Used by
    # the manual wallet-refresh endpoint to trigger a per-user re-scan.
    indexer_url: str = "http://indexer:8080"

    # Public-facing site (REQUIRED).
    # Used to build OAuth redirect, Telegram webhook URL, SSR OG/sitemap URLs.
    public_base_url: str = ""           # e.g. https://vote.example.com

    # Tracker UI base URL — only used so the frontend can link out to
    # tracker.<host>/address/X / /tx/X for explorers. Leave empty to hide
    # those links.
    tracker_ui_url: str = ""            # e.g. https://tracker.example.com

    # Tracker API (read-only governance mirror). REQUIRED.
    tracker_api_url: str = ""           # e.g. http://tracker.example.com/api/v1

    # WalletConnect projectId from https://cloud.reown.com/. REQUIRED for
    # the in-app wallet flow; leave empty to disable WC.
    wc_project_id: str = ""

    # Auth providers.
    google_client_id: str = ""
    google_client_secret: str = ""
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    session_secret: str = "dev-only-change-me"
    cookie_secure: bool = False        # True in prod (HTTPS)
    cookie_domain: str | None = None

    # CORS — typically equals [public_base_url].
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Logging
    log_level: str = "INFO"

    # Governance polling.
    governance_poll_interval: int = 60   # seconds between active-proposal pulls
    governance_list_ttl: int = 300       # /api/governance/proposals freshness threshold
    governance_detail_ttl: int = 60      # per-proposal lazy-refresh threshold

    # Translation worker (Gemini).
    gemini_api_key_1: str = ""
    gemini_api_key_2: str = ""
    gemini_api_key_3: str = ""
    translation_languages: str = "en,ru"
    translation_poll_interval: int = 5
    translation_max_attempts: int = 5

    # Telegram notifier service.
    notification_poll_interval: int = 5
    notification_max_attempts: int = 3
    notification_retry_delay_sec: int = 60
    telegram_webhook_secret: str = ""


settings = Settings()


def effective_backend_chain_api_url() -> str:
    """Backend-facing REST URL with fallback to the indexer's CHAIN_API_URL."""
    return (settings.backend_chain_api_url or settings.chain_api_url).rstrip("/")


def effective_backend_rpc_url() -> str:
    """Backend-facing RPC URL (for the SPA CLI hint) with fallback to RPC_URL."""
    return (settings.backend_rpc_url or settings.rpc_url).rstrip("/")


# Names that MUST be set in production. Checked at app startup; missing
# values produce a single clear error instead of a cascade of cryptic
# failures from individual components (404s, OAuth redirect mismatches,
# WC connect errors, etc).
REQUIRED_PROD_FIELDS = (
    "chain_id",
    "chain_api_url",
    "rpc_url",
    "public_base_url",
    "tracker_api_url",
)


def validate_required() -> list[str]:
    """Return names of missing required settings. Empty list = OK."""
    return [
        f for f in REQUIRED_PROD_FIELDS
        if not (getattr(settings, f, "") or "").strip()
    ]
