# Gonka Vote

Community-driven tender portal for the [Gonka](https://gonka.ai) blockchain.
Anyone with a Google account can propose a tender and discuss it; anyone with
GNK can vote on it from their wallet. Votes are weighted by current GNK balance
and re-tallied every minute. Tenders here are **indicative** — they do not
modify the chain or spend treasury funds. For binding governance use the
native `x/gov` proposals.

## Architecture

```
                                     ┌──────────────┐
                                     │ User wallet  │
                                     │ (CLI or app) │
                                     └──────┬───────┘
                                            │ MsgExecuteContract
                                            ▼
┌────────────┐    Google OAuth     ┌──────────────────┐    tx_search +
│  Browser   │ ◄──────────────────►│  Gonka chain     │◄─── /balances/...
└─────┬──────┘                     │  contract: vote  │
      │                            └──────────────────┘
      │ /api/...                                ▲
      ▼                                         │
┌──────────────┐    SQL    ┌────────────┐       │
│ frontend     │           │ ClickHouse │◄──────┤
│ (Vite/React) │           │ gonka_vote │       │
└──────────────┘           └────────────┘       │
      ▲                          ▲              │
      │ /api/...                 │ writes       │
      │                          │              │
┌──────────────┐                 │       ┌──────┴──────┐
│ backend      │─────────────────┘       │  indexer    │
│ (FastAPI)    │                         │  (Go)       │
└──────────────┘                         └─────────────┘
```

Stack mirrors [`tracker/`](../tracker/) so we can reuse patterns:
ClickHouse + Go indexer + FastAPI + React/Vite + Traefik.

## Layout

- `contract/` — CosmWasm Rust contract. One execute message: `Vote { tender_id, choice }`.
- `indexer/` — Go service that polls the chain via Tendermint `tx_search` for
  `MsgExecuteContract` targeting our contract, parses `{"vote":...}` messages,
  writes votes to ClickHouse, and refreshes per-voter ngonka balance snapshots
  every minute.
- `backend/` — FastAPI app: tenders/comments/users CRUD, Google OAuth login,
  signed-cookie sessions. Reads from ClickHouse only.
- `frontend/` — Vite + React + TanStack Query + Tailwind, dark theme matching
  [gonka-vip](../gonka-vip/).
- `backend/ch_migrations/001_init.sql` — auto-applied on first ClickHouse start.
- `docker-compose.yaml` — Traefik + ClickHouse + indexer + backend + frontend.

## First-time setup

### 1. Build & deploy the contract (one-time)

```bash
cd contract
./scripts/build.sh                       # produces artifacts/gonka_tenders.wasm
inferenced keys add deployer             # if you don't have a key yet
FROM_KEY=deployer ./scripts/deploy.sh    # store + instantiate on mainnet
# Output prints contract_address — copy it.
```

### 2. Google OAuth credentials

Create OAuth 2.0 credentials at <https://console.cloud.google.com/apis/credentials>:
- Application type: **Web application**
- Authorized redirect URI: `https://<your-domain>/api/auth/callback`

### 3. Server config

```bash
cp .env.template .env
# Fill in:
#   PUBLIC_HOST, PUBLIC_BASE_URL, TRAEFIK_EMAIL
#   CONTRACT_ADDRESS (from step 1)
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
#   SESSION_SECRET=$(openssl rand -hex 32)
```

### 4. Boot

```bash
docker compose up -d --build
docker compose logs -f indexer backend
```

ClickHouse migrations are auto-applied on first start (mounted into
`/docker-entrypoint-initdb.d/`).

### 5. Test

```bash
# Create a tender via the UI, copy its UUID, then vote from CLI:
inferenced tx wasm execute $CONTRACT_ADDRESS \
  '{"vote":{"tender_id":"<uuid>","choice":"yes"}}' \
  --from <your-key> --chain-id gonka-mainnet \
  --node http://node2.gonka.ai:8000/chain-rpc -y

# Within ~60 s the tender page should show your vote weighted by your ngonka.
```

## Local dev

Run only ClickHouse via Docker, run backend + frontend natively for hot reload:

```bash
docker compose up -d clickhouse
cd backend && pip install -e . && \
  uvicorn backend.app:app --reload --port 8000
cd frontend && npm install && npm run dev
```

Frontend dev server proxies `/api` → `localhost:8000`.

## Deploy to Azure VPS

The compose file is self-contained. On a fresh Ubuntu VPS with Docker:

```bash
git clone <this-repo> vote && cd vote
cp .env.template .env && $EDITOR .env
docker compose up -d --build
```

TLS is terminated by **Cloudflare** in front of the server (Flexible SSL
mode). Traefik on the VPS only listens on port 80; only :80 needs to be open
to the public. Point an `A` record (proxied / orange cloud) for
your `PUBLIC_HOST` at the VPS IP before first boot. Cloudflare will speak
HTTPS to browsers and HTTP to the origin — the origin must always answer on
plain :80.

## What's deferred (Phase 2)

- WalletConnect "Vote" button — needs `MsgExecuteContract` support added to
  the [Gonka wallet](../wallet/) (~50 lines of Dart).
- Quorum / pass-fail thresholds per tender.
- Tags / categories / search.
- Reward distribution to tender authors.
