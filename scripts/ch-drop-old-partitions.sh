#!/usr/bin/env bash
#
# Drop all yesterday-or-older partitions from ClickHouse system log tables.
# CH's built-in TTL doesn't reliably prune cold partitions (upstream #34929)
# so this cron replicates the same effect: keep only today's rows.
#
# Runs against the local `gonka-vote-clickhouse` container.

set -euo pipefail

TABLES=(
  metric_log
  text_log
  query_log
  trace_log
  part_log
  query_metric_log
  asynchronous_metric_log
  processors_profile_log
  error_log
)

TODAY=$(date -u +%Y%m%d)

for tbl in "${TABLES[@]}"; do
  partitions=$(docker exec gonka-vote-clickhouse clickhouse-client --query \
    "SELECT DISTINCT partition FROM system.parts
     WHERE database = 'system' AND table = '${tbl}' AND active
       AND partition != '${TODAY}'" 2>/dev/null || true)

  for p in $partitions; do
    docker exec gonka-vote-clickhouse clickhouse-client --query \
      "ALTER TABLE system.${tbl} DROP PARTITION '${p}'" \
      && echo "dropped ${tbl} ${p}"
  done
done
