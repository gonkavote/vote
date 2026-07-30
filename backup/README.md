# Daily ClickHouse backup → Cloudflare R2

## What runs
`docker compose service: backup` — Alpine container with `clickhouse-client`
and `aws-cli`. Sleeps until `BACKUP_TIME` UTC (default 03:00), then dumps
every user table in `gonka_vote` in `Native` format, gzips them into one
tarball, and uploads to `s3://$R2_BUCKET/daily/gonka_vote-YYYYMMDD-HHMMSS.tar.gz`.
After upload it prunes remote backups older than `BACKUP_RETENTION_DAYS`
(default 30).

## Env vars
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` —
set in the server's `.env`. Optional: `BACKUP_TIME=HH:MM`,
`BACKUP_RETENTION_DAYS=N`, `BACKUP_RUN_ON_START=true` (fires an immediate
backup on container start, then continues the daily loop).

## Verify a backup
```bash
docker compose logs backup --tail 100
```
Or list what's in R2:
```bash
docker compose exec backup aws s3 ls "s3://$R2_BUCKET/daily/" \
  --endpoint-url "$R2_ENDPOINT"
```

## Restore

1. Download the desired bundle:
   ```bash
   docker compose exec backup aws s3 cp \
     "s3://$R2_BUCKET/daily/gonka_vote-YYYYMMDD-HHMMSS.tar.gz" /tmp/b.tgz \
     --endpoint-url "$R2_ENDPOINT"
   ```
2. Copy it out and extract:
   ```bash
   docker cp gonka-vote-backup:/tmp/b.tgz .
   mkdir restore && tar -xzf b.tgz -C restore
   ```
   You'll get `schema.sql` and one `<table>.native.gz` per table.
3. If restoring to a fresh cluster: `clickhouse-client -q "CREATE DATABASE gonka_vote"`
   then apply `schema.sql` (edit to add `IF NOT EXISTS` if some tables exist).
4. Load each table:
   ```bash
   gunzip -c restore/users.native.gz | \
     clickhouse-client -q "INSERT INTO gonka_vote.users FORMAT Native"
   ```
   Order doesn't matter — no FK constraints in ClickHouse. `ReplacingMergeTree`
   tables merge duplicates by `ORDER BY` key on the next OPTIMIZE.
