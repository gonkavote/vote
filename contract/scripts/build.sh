#!/usr/bin/env bash
# Reproducible wasm build via the official CosmWasm optimizer.
# Output: artifacts/gonka_tenders.wasm + checksums.txt
set -euo pipefail

cd "$(dirname "$0")/.."

docker run --rm \
  -v "$(pwd)":/code \
  -v "${HOME}/.cargo/registry":/usr/local/cargo/registry \
  -v "$(basename "$(pwd)")_cache":/code/target \
  cosmwasm/optimizer:0.17.0

echo
echo "Built artifacts:"
ls -lh artifacts/
sha256sum artifacts/*.wasm
