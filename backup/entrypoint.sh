#!/usr/bin/env bash
# Long-running loop: sleep until BACKUP_TIME (HH:MM UTC), then run backup.sh.
# Simpler and more visible in `docker logs` than dropping a real cron in busybox.
set -euo pipefail

: "${BACKUP_TIME:=03:00}"   # UTC HH:MM

if [[ "${RUN_ON_START:-false}" == "true" ]]; then
  echo "[entrypoint] RUN_ON_START=true → running backup immediately"
  /usr/local/bin/backup.sh || echo "[entrypoint] initial backup FAILED (continuing)"
fi

while true; do
  # Sleep until next occurrence of BACKUP_TIME UTC.
  now=$(date -u +%s)
  today_target=$(date -u -d "$(date -u +%Y-%m-%d) $BACKUP_TIME:00" +%s 2>/dev/null || \
                 date -u -j -f "%Y-%m-%d %H:%M:%S" \
                   "$(date -u +%Y-%m-%d) $BACKUP_TIME:00" +%s)
  if (( today_target <= now )); then
    target=$(( today_target + 86400 ))
  else
    target=$today_target
  fi
  wait=$(( target - now ))
  echo "[entrypoint] next backup at $(date -u -d "@$target" 2>/dev/null || date -u -r "$target") (in ${wait}s)"
  sleep "$wait"
  echo "[entrypoint] === backup run $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  /usr/local/bin/backup.sh || echo "[entrypoint] backup FAILED — will retry on next schedule"
done
