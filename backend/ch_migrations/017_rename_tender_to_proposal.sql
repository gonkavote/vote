-- Migration 017: rename tender → proposal
--
-- Applied by hand on target 20.33.30.135 via `docker exec gonka-vote-clickhouse
-- clickhouse-client --query "..."` — one statement at a time (mixing DDL and
-- data-copy in a single client call is unreliable on 24.12).
--
-- Backup taken to /Users/admin/Downloads/ch_dump_before_rename.tar.gz before
-- starting. If anything goes sideways, restore per-table with
--   cat <table>.native | docker exec -i gonka-vote-clickhouse \
--       clickhouse-client --query "INSERT INTO gonka_vote.<table> FORMAT Native"
--
-- Semantics preserved:
--   * `tenders` and `tender_translations` renamed straightforwardly to
--     proposals / proposal_translations. Column `tender_id` in the latter
--     becomes `proposal_id`.
--   * `votes.tender_id` and `vote_snapshots.tender_id` become `proposal_id`
--     (still String — smart-contract wire format).
--   * `comments.tender_id` → `entity_id`: the column is already polymorphic
--     (governance router encodes proposal_id as a synthetic UUID and reuses
--     this column). `entity_id` reflects that reality.
--   * `notification_jobs.target_tender_id` → `target_entity_id` (same reason).
--   * `translation_jobs.kind` values 'tender'/'detect_tender' become
--     'proposal'/'detect_proposal'.
--
-- Only 5 tables need a rewrite because the renamed column is in ORDER BY
-- (RENAME COLUMN can't touch sort keys). Row counts are tiny (<2K total),
-- rewrites run in <1s.

-- ---------------------------------------------------------------------------
-- 1. tenders → proposals (in-place table rename; id is PK, unchanged)
-- ---------------------------------------------------------------------------
RENAME TABLE gonka_vote.tenders TO gonka_vote.proposals;

-- ---------------------------------------------------------------------------
-- 2. tender_translations → proposal_translations (rewrite: tender_id in ORDER BY)
-- ---------------------------------------------------------------------------
CREATE TABLE gonka_vote.proposal_translations
(
    `proposal_id` UUID,
    `target_lang` LowCardinality(String),
    `title` String,
    `summary` String CODEC(ZSTD(3)),
    `description` String CODEC(ZSTD(3)),
    `updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (proposal_id, target_lang)
SETTINGS index_granularity = 8192;

INSERT INTO gonka_vote.proposal_translations
    (proposal_id, target_lang, title, summary, description, updated_at)
SELECT tender_id, target_lang, title, summary, description, updated_at
FROM gonka_vote.tender_translations FINAL;

DROP TABLE gonka_vote.tender_translations;

-- ---------------------------------------------------------------------------
-- 3. votes: rewrite (tender_id in ORDER BY + named skip index)
-- ---------------------------------------------------------------------------
CREATE TABLE gonka_vote.votes_new
(
    `proposal_id` String,
    `voter` String,
    `amount_ngonka` UInt128,
    `height` UInt64,
    `tx_hash` FixedString(64),
    `timestamp` DateTime64(3, 'UTC'),
    `indexed_at` DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_proposal proposal_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplacingMergeTree(height)
ORDER BY (proposal_id, voter)
SETTINGS index_granularity = 8192;

INSERT INTO gonka_vote.votes_new
    (proposal_id, voter, amount_ngonka, height, tx_hash, timestamp, indexed_at)
SELECT tender_id, voter, amount_ngonka, height, tx_hash, timestamp, indexed_at
FROM gonka_vote.votes FINAL;

DROP TABLE gonka_vote.votes;
RENAME TABLE gonka_vote.votes_new TO gonka_vote.votes;

-- ---------------------------------------------------------------------------
-- 4. vote_snapshots: rewrite (tender_id in ORDER BY)
-- ---------------------------------------------------------------------------
CREATE TABLE gonka_vote.vote_snapshots_new
(
    `proposal_id` String,
    `voter` String,
    `amount_ngonka` UInt128,
    `weight_ngonka` UInt128,
    `refreshed_at` DateTime64(3, 'UTC') DEFAULT now64(3),
    `tx_hash` FixedString(64) DEFAULT '',
    `balance_ngonka` UInt128 DEFAULT 0,
    `collateral_ngonka` UInt128 DEFAULT 0,
    `vesting_ngonka` UInt128 DEFAULT 0,
    `host_weight` UInt128 DEFAULT 0,
    `voted_at` Nullable(DateTime64(3, 'UTC'))
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY (proposal_id, voter)
SETTINGS index_granularity = 8192;

INSERT INTO gonka_vote.vote_snapshots_new
    (proposal_id, voter, amount_ngonka, weight_ngonka, refreshed_at, tx_hash,
     balance_ngonka, collateral_ngonka, vesting_ngonka, host_weight, voted_at)
SELECT tender_id, voter, amount_ngonka, weight_ngonka, refreshed_at, tx_hash,
       balance_ngonka, collateral_ngonka, vesting_ngonka, host_weight, voted_at
FROM gonka_vote.vote_snapshots FINAL;

DROP TABLE gonka_vote.vote_snapshots;
RENAME TABLE gonka_vote.vote_snapshots_new TO gonka_vote.vote_snapshots;

-- ---------------------------------------------------------------------------
-- 5. comments: rewrite (tender_id → entity_id; column in ORDER BY, partition by month)
-- ---------------------------------------------------------------------------
CREATE TABLE gonka_vote.comments_new
(
    `id` UUID DEFAULT generateUUIDv4(),
    `entity_id` UUID,
    `author_email` String,
    `author_name` Nullable(String),
    `body` String CODEC(ZSTD(3)),
    `created_at` DateTime64(3, 'UTC') DEFAULT now64(3),
    `parent_comment_id` Nullable(UUID),
    `author_uid` String DEFAULT '',
    `deleted_at` Nullable(DateTime64(3, 'UTC')),
    `deleted_by_email` String DEFAULT '',
    `source_lang` LowCardinality(String) DEFAULT '',
    `body_t` String DEFAULT '{}'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (entity_id, created_at)
SETTINGS index_granularity = 8192;

INSERT INTO gonka_vote.comments_new
    (id, entity_id, author_email, author_name, body, created_at,
     parent_comment_id, author_uid, deleted_at, deleted_by_email,
     source_lang, body_t)
SELECT id, tender_id, author_email, author_name, body, created_at,
       parent_comment_id, author_uid, deleted_at, deleted_by_email,
       source_lang, body_t
FROM gonka_vote.comments;

DROP TABLE gonka_vote.comments;
RENAME TABLE gonka_vote.comments_new TO gonka_vote.comments;

-- ---------------------------------------------------------------------------
-- 6. notification_jobs.target_tender_id → target_entity_id (in-place rename)
--    NOT in ORDER BY → metadata-only op.
-- ---------------------------------------------------------------------------
ALTER TABLE gonka_vote.notification_jobs
    RENAME COLUMN target_tender_id TO target_entity_id;

-- ---------------------------------------------------------------------------
-- 7. translation_jobs.kind values: 'tender' → 'proposal', 'detect_tender' → 'detect_proposal'
--    kind is FIRST column in ORDER BY, so UPDATE-mutation would break sort;
--    rewrite is the safe path.
-- ---------------------------------------------------------------------------
CREATE TABLE gonka_vote.translation_jobs_new
(
    `kind` LowCardinality(String),
    `entity_id` UUID,
    `target_lang` LowCardinality(String),
    `status` LowCardinality(String) DEFAULT 'pending',
    `attempts` UInt8 DEFAULT 0,
    `last_error` String DEFAULT '',
    `enqueued_at` DateTime64(3, 'UTC') DEFAULT now64(3),
    `started_at` Nullable(DateTime64(3, 'UTC')),
    `finished_at` Nullable(DateTime64(3, 'UTC')),
    `next_attempt_at` Nullable(DateTime64(3, 'UTC')),
    `updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (kind, entity_id, target_lang)
SETTINGS index_granularity = 8192;

INSERT INTO gonka_vote.translation_jobs_new
    (kind, entity_id, target_lang, status, attempts, last_error,
     enqueued_at, started_at, finished_at, next_attempt_at, updated_at)
SELECT
    multiIf(kind = 'tender', 'proposal',
            kind = 'detect_tender', 'detect_proposal',
            kind) AS kind,
    entity_id, target_lang, status, attempts, last_error,
    enqueued_at, started_at, finished_at, next_attempt_at, updated_at
FROM gonka_vote.translation_jobs FINAL;

DROP TABLE gonka_vote.translation_jobs;
RENAME TABLE gonka_vote.translation_jobs_new TO gonka_vote.translation_jobs;
