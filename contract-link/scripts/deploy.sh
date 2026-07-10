#!/usr/bin/env bash
# Store + instantiate the contract on Gonka mainnet using the local
# `forgonka/build/inferenced` binary and the `personal` key from the
# file-backend keyring.
#
# Password is read from forgonka/.keyring_password (chmod 600), or from the
# KEYRING_PASSWORD env var if the file is missing.
#
# Override defaults via env vars: FROM_KEY, NODE, CHAIN_ID, LABEL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACT_DIR/../.." && pwd)"

INFERENCED="${INFERENCED:-$REPO_ROOT/forgonka/build/inferenced}"
PASSWORD_FILE="${PASSWORD_FILE:-$REPO_ROOT/forgonka/.keyring_password}"

FROM_KEY="${FROM_KEY:-personal}"
NODE="${NODE:-http://node2.gonka.ai:8000/chain-rpc/}"
CHAIN_ID="${CHAIN_ID:-gonka-mainnet}"
LABEL="${LABEL:-gonka-vote-v1}"
KEYRING_BACKEND="${KEYRING_BACKEND:-file}"
WASM="$CONTRACT_DIR/artifacts/gonka_tenders.wasm"

# ----------------------------------------------------------------------------
# Sanity checks
# ----------------------------------------------------------------------------
if [[ ! -x "$INFERENCED" ]]; then
  echo "ERROR: inferenced binary not found or not executable: $INFERENCED" >&2
  exit 1
fi

if [[ ! -f "$WASM" ]]; then
  echo "ERROR: wasm artifact missing. Build first: ./scripts/build.sh" >&2
  exit 1
fi

if [[ -f "$PASSWORD_FILE" ]]; then
  PASSWORD="$(cat "$PASSWORD_FILE")"
elif [[ -n "${KEYRING_PASSWORD:-}" ]]; then
  PASSWORD="$KEYRING_PASSWORD"
else
  echo "ERROR: no keyring password found." >&2
  echo "  Either create $PASSWORD_FILE (chmod 600) or set KEYRING_PASSWORD env var." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (brew install jq)" >&2
  exit 1
fi

# ----------------------------------------------------------------------------
# Show what we're about to do
# ----------------------------------------------------------------------------
ADDR=$(printf '%s\n' "$PASSWORD" | "$INFERENCED" keys show "$FROM_KEY" \
  --keyring-backend "$KEYRING_BACKEND" -a 2>/dev/null)
if [[ -z "$ADDR" ]]; then
  echo "ERROR: failed to resolve address for key '$FROM_KEY'" >&2
  exit 1
fi

WASM_SIZE=$(wc -c < "$WASM" | awk '{print $1}')
WASM_SHA=$(shasum -a 256 "$WASM" | awk '{print $1}')

cat <<EOF
============================================================
About to deploy contract:
  inferenced:       $INFERENCED
  wasm:             $WASM ($WASM_SIZE bytes)
  sha256:           $WASM_SHA
  from key:         $FROM_KEY ($ADDR)
  chain_id:         $CHAIN_ID
  node:             $NODE
  label:            $LABEL
  keyring backend:  $KEYRING_BACKEND
============================================================
EOF
read -p "Proceed? [y/N] " -r CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }

# ----------------------------------------------------------------------------
# 1. Store wasm code
# ----------------------------------------------------------------------------
echo
echo "==> Storing wasm code..."
STORE_OUT=$(printf '%s\n' "$PASSWORD" | "$INFERENCED" tx wasm store "$WASM" \
  --from "$FROM_KEY" --keyring-backend "$KEYRING_BACKEND" \
  --chain-id "$CHAIN_ID" --node "$NODE" \
  --gas auto --gas-adjustment 1.5 \
  -y --output json 2>&1)

TX_HASH=$(echo "$STORE_OUT" | grep -oE '"txhash":"[A-F0-9]+"' | head -1 | sed 's/"txhash":"//;s/"//')
if [[ -z "$TX_HASH" ]]; then
  echo "ERROR: store tx did not return a txhash. Output:" >&2
  echo "$STORE_OUT" >&2
  exit 1
fi
echo "store tx: $TX_HASH"

# Wait for inclusion + index
echo "waiting for tx to be indexed..."
CODE_ID=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  TX_JSON=$("$INFERENCED" query tx "$TX_HASH" --node "$NODE" --output json 2>/dev/null || true)
  if [[ -n "$TX_JSON" ]]; then
    CODE_ID=$(echo "$TX_JSON" | jq -r '
      (.events // [])
      | map(select(.type=="store_code"))
      | .[0].attributes // []
      | map(select(.key=="code_id"))
      | .[0].value // empty
    ')
    if [[ -n "$CODE_ID" ]]; then
      break
    fi
  fi
  echo "  attempt $i: not yet indexed..."
done

if [[ -z "$CODE_ID" ]]; then
  echo "ERROR: could not find code_id in tx events for $TX_HASH" >&2
  exit 1
fi
echo "code_id: $CODE_ID"

# ----------------------------------------------------------------------------
# 2. Instantiate
# ----------------------------------------------------------------------------
echo
echo "==> Instantiating contract..."
INST_OUT=$(printf '%s\n' "$PASSWORD" | "$INFERENCED" tx wasm instantiate "$CODE_ID" '{}' \
  --label "$LABEL" --no-admin \
  --from "$FROM_KEY" --keyring-backend "$KEYRING_BACKEND" \
  --chain-id "$CHAIN_ID" --node "$NODE" \
  --gas auto --gas-adjustment 1.5 \
  -y --output json 2>&1)

INST_HASH=$(echo "$INST_OUT" | grep -oE '"txhash":"[A-F0-9]+"' | head -1 | sed 's/"txhash":"//;s/"//')
if [[ -z "$INST_HASH" ]]; then
  echo "ERROR: instantiate tx did not return a txhash. Output:" >&2
  echo "$INST_OUT" >&2
  exit 1
fi
echo "instantiate tx: $INST_HASH"

echo "waiting for tx to be indexed..."
CONTRACT=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  TX_JSON=$("$INFERENCED" query tx "$INST_HASH" --node "$NODE" --output json 2>/dev/null || true)
  if [[ -n "$TX_JSON" ]]; then
    CONTRACT=$(echo "$TX_JSON" | jq -r '
      (.events // [])
      | map(select(.type=="instantiate"))
      | .[0].attributes // []
      | map(select(.key=="_contract_address"))
      | .[0].value // empty
    ')
    if [[ -n "$CONTRACT" ]]; then
      break
    fi
  fi
  echo "  attempt $i: not yet indexed..."
done

if [[ -z "$CONTRACT" ]]; then
  echo "ERROR: could not find contract_address in tx events for $INST_HASH" >&2
  exit 1
fi

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------
cat <<EOF

============================================================
✓ Deploy successful
============================================================
  code_id:           $CODE_ID
  contract_address:  $CONTRACT
  store tx:          $TX_HASH
  instantiate tx:    $INST_HASH

Add to vote/.env:
  CONTRACT_ADDRESS=$CONTRACT
============================================================
EOF
