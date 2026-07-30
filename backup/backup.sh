#!/usr/bin/env bash
# Dump the whole gonka_vote database from ClickHouse and upload it to
# Cloudflare R2 as a single gzipped Native-format file. Then prune remote
# backups older than $BACKUP_RETENTION_DAYS.
#
# Native format is round-trip-safe for every column type we use (UUID,
# UInt128, Nullable, LowCardinality, DateTime64) and is what
# `clickhouse-client --query "INSERT ... FORMAT Native"` consumes on restore.
set -euo pipefail

: "${CLICKHOUSE_HOST:?CLICKHOUSE_HOST is required}"
: "${CLICKHOUSE_DATABASE:?CLICKHOUSE_DATABASE is required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${BACKUP_RETENTION_DAYS:=30}"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

CH_ARGS=(--host "$CLICKHOUSE_HOST" --port "${CLICKHOUSE_PORT:-9000}" \
         --user "${CLICKHOUSE_USER:-default}" \
         --database "$CLICKHOUSE_DATABASE")
[[ -n "${CLICKHOUSE_PASSWORD:-}" ]] && CH_ARGS+=(--password "$CLICKHOUSE_PASSWORD")

TS="$(date -u +%Y%m%d-%H%M%S)"
WORK="/tmp/backup-$TS"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# List user tables (skip system + temp __-prefixed) and dump each in Native
# format. One file per table keeps partial restores possible.
log "listing tables in $CLICKHOUSE_DATABASE …"
mapfile -t TABLES < <(clickhouse-client "${CH_ARGS[@]}" --query \
  "SELECT name FROM system.tables
   WHERE database = '$CLICKHOUSE_DATABASE'
     AND engine NOT LIKE 'View%'
     AND name NOT LIKE '\\_\\_%'
   ORDER BY name")

if [[ ${#TABLES[@]} -eq 0 ]]; then
  log "no tables to back up, aborting"
  exit 1
fi
log "found ${#TABLES[@]} table(s)"

for tbl in "${TABLES[@]}"; do
  out="$WORK/${tbl}.native.gz"
  log "  dumping $tbl → $out"
  # `--query` with `FORMAT Native` streams binary; pipe straight into gzip.
  clickhouse-client "${CH_ARGS[@]}" --query \
    "SELECT * FROM \`$CLICKHOUSE_DATABASE\`.\`$tbl\` FORMAT Native" \
    | gzip -6 > "$out"
done

# Schema (CREATE TABLE for each) — needed to restore into a fresh cluster.
log "  dumping schema"
{
  for tbl in "${TABLES[@]}"; do
    clickhouse-client "${CH_ARGS[@]}" --query \
      "SHOW CREATE TABLE \`$CLICKHOUSE_DATABASE\`.\`$tbl\`" \
      | sed 's/\\n/\n/g'
    echo ";"
    echo
  done
} > "$WORK/schema.sql"

# One tarball for atomicity, then upload.
BUNDLE="$WORK/gonka_vote-$TS.tar.gz"
log "packing $BUNDLE"
tar -C "$WORK" -czf "$BUNDLE" --exclude "$(basename "$BUNDLE")" .

SIZE=$(du -h "$BUNDLE" | awk '{print $1}')
KEY="daily/gonka_vote-$TS.tar.gz"
log "uploading s3://$R2_BUCKET/$KEY ($SIZE)"
aws s3 cp "$BUNDLE" "s3://$R2_BUCKET/$KEY" \
  --endpoint-url "$R2_ENDPOINT" \
  --only-show-errors

log "prune backups older than $BACKUP_RETENTION_DAYS days"
CUTOFF=$(date -u -d "-$BACKUP_RETENTION_DAYS days" +%s 2>/dev/null \
         || date -u -v-"${BACKUP_RETENTION_DAYS}"d +%s)
aws s3api list-objects-v2 \
  --bucket "$R2_BUCKET" \
  --prefix "daily/" \
  --endpoint-url "$R2_ENDPOINT" \
  --query 'Contents[].{Key:Key,LastModified:LastModified}' \
  --output text 2>/dev/null \
  | while read -r key lastmod; do
      [[ -z "$key" ]] && continue
      ts=$(date -u -d "$lastmod" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S+00:00" "${lastmod%%.*}+00:00" +%s 2>/dev/null || echo "")
      [[ -z "$ts" ]] && continue
      if (( ts < CUTOFF )); then
        log "  deleting old: $key (age > ${BACKUP_RETENTION_DAYS}d)"
        aws s3 rm "s3://$R2_BUCKET/$key" \
          --endpoint-url "$R2_ENDPOINT" --only-show-errors || true
      fi
    done

log "backup done."
