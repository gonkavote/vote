-- Migration 018: proposal reactions + wallet links + requested amounts
--
-- Applied by hand on target via docker exec + clickhouse-client. Backup of
-- proposals table taken to /tmp/ch_backup_reactions/proposals.native before
-- ALTER; new tables have no pre-existing data.

-- Proposal reactions (mirrors comment_reactions schema).
CREATE TABLE gonka_vote.proposal_reactions
(
    `proposal_id`   UUID,
    `reactor_uid`   String,
    `reaction_type` String,
    `updated_at`    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (proposal_id, reactor_uid)
SETTINGS index_granularity = 8192;

-- Wallet ↔ account_uid mapping, populated by indexer link_scanner.
-- balance_ngonka refreshed hourly by the balance_refresher job.
CREATE TABLE gonka_vote.wallet_links
(
    `wallet`               String,
    `account_uid`          String,
    `balance_ngonka`       UInt128 DEFAULT 0,
    `linked_at`            DateTime64(3, 'UTC') DEFAULT now64(3),
    `balance_refreshed_at` Nullable(DateTime64(3, 'UTC')),
    `unlinked_at`          Nullable(DateTime64(3, 'UTC')),
    `updated_at`           DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (wallet)
SETTINGS index_granularity = 8192;

-- Requested funding fields for community proposals.
ALTER TABLE gonka_vote.proposals
    ADD COLUMN requested_amount_usdt UInt64 DEFAULT 0,
    ADD COLUMN requested_amount_gnk  UInt64 DEFAULT 0;
