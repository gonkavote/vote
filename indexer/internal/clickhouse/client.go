package clickhouse

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/gonka/vote/indexer/internal/config"
)

type Client struct {
	conn driver.Conn
}

func New(cfg config.ClickHouseConfig) (*Client, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)},
		Auth: clickhouse.Auth{
			Database: cfg.Database,
			Username: cfg.User,
			Password: cfg.Password,
		},
		DialTimeout:     5 * time.Second,
		ConnMaxLifetime: 10 * time.Minute,
		MaxOpenConns:    10,
		MaxIdleConns:    5,
		Settings: clickhouse.Settings{
			"max_execution_time": 60,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("clickhouse open: %w", err)
	}
	if err := conn.Ping(context.Background()); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	return &Client{conn: conn}, nil
}

func (c *Client) Close() error { return c.conn.Close() }

func (c *Client) Ping(ctx context.Context) error { return c.conn.Ping(ctx) }

// ----------------------------------------------------------------------------
// Indexer state
// ----------------------------------------------------------------------------

func (c *Client) GetCheckpoint(ctx context.Context, task string) (uint64, error) {
	var h uint64
	err := c.conn.QueryRow(ctx, `
		SELECT last_height
		FROM gonka_vote.indexer_state FINAL
		WHERE task = ?
	`, task).Scan(&h)
	if err != nil {
		return 0, nil
	}
	return h, nil
}

func (c *Client) SetCheckpoint(ctx context.Context, task string, height uint64) error {
	return c.conn.Exec(ctx, `
		INSERT INTO gonka_vote.indexer_state (task, last_height, updated_at)
		VALUES (?, ?, ?)
	`, task, height, time.Now().UTC())
}

// ----------------------------------------------------------------------------
// Votes
// ----------------------------------------------------------------------------

type VoteRow struct {
	ProposalID     string
	Voter        string
	AmountNgonka *big.Int
	Height       uint64
	TxHash       string
	Timestamp    time.Time
}

func (c *Client) InsertVotes(ctx context.Context, rows []VoteRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		`INSERT INTO gonka_vote.votes (proposal_id, voter, amount_ngonka, height, tx_hash, timestamp)`)
	if err != nil {
		return fmt.Errorf("prepare votes batch: %w", err)
	}
	for _, r := range rows {
		amt := r.AmountNgonka
		if amt == nil {
			amt = big.NewInt(0)
		}
		if err := batch.Append(r.ProposalID, r.Voter, amt, r.Height, r.TxHash, r.Timestamp); err != nil {
			return fmt.Errorf("append vote: %w", err)
		}
	}
	return batch.Send()
}

// ListOpenProposalVoters returns (proposal_id, voter, amount_ngonka, tx_hash,
// voted_at) for OPEN proposals. Used by snapshot refresher.
type VoterRow struct {
	ProposalID     string
	Voter        string
	AmountNgonka *big.Int
	TxHash       string
	VotedAt      time.Time
}

func (c *Client) ListOpenProposalVoters(ctx context.Context) ([]VoterRow, error) {
	rows, err := c.conn.Query(ctx, `
		SELECT v.proposal_id, v.voter, v.amount_ngonka, v.tx_hash, v.timestamp
		FROM gonka_vote.votes v FINAL
		WHERE v.proposal_id IN (
			SELECT toString(id) FROM gonka_vote.proposals FINAL
			WHERE status = 'open' AND deleted_at IS NULL
			  AND (closes_at IS NULL OR closes_at > now64(3))
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("list voters: %w", err)
	}
	defer rows.Close()

	var out []VoterRow
	for rows.Next() {
		var (
			proposalID string
			voter    string
			amount   *big.Int
			txHash   string
			votedAt  time.Time
		)
		if err := rows.Scan(&proposalID, &voter, &amount, &txHash, &votedAt); err != nil {
			return nil, err
		}
		out = append(out, VoterRow{
			ProposalID: proposalID, Voter: voter, AmountNgonka: amount,
			TxHash: txHash, VotedAt: votedAt,
		})
	}
	return out, rows.Err()
}

// ----------------------------------------------------------------------------
// Vote snapshots
// ----------------------------------------------------------------------------

type SnapshotRow struct {
	ProposalID         string
	Voter            string
	AmountNgonka     *big.Int
	WeightNgonka     *big.Int // legacy: equal to BalanceNgonka+CollateralNgonka+VestingNgonka
	BalanceNgonka    *big.Int
	CollateralNgonka *big.Int
	VestingNgonka    *big.Int
	HostWeight       *big.Int // weight × confirmation_poc_ratio, integer
	TxHash           string
	VotedAt          time.Time
}

// ----------------------------------------------------------------------------
// Wallet ↔ account_uid links (populated from LinkAccount contract events)
// ----------------------------------------------------------------------------

type LinkRow struct {
	Wallet      string
	AccountUID  string
	Height      uint64
	Timestamp   time.Time
}

// UpsertWalletLinks inserts/overwrites (wallet → account_uid) rows.
// ReplacingMergeTree(updated_at) picks the freshest row per wallet.
func (c *Client) UpsertWalletLinks(ctx context.Context, rows []LinkRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		`INSERT INTO gonka_vote.wallet_links
		    (wallet, account_uid, balance_ngonka, linked_at, updated_at)`)
	if err != nil {
		return fmt.Errorf("prepare links batch: %w", err)
	}
	for _, r := range rows {
		if err := batch.Append(r.Wallet, r.AccountUID, big.NewInt(0), r.Timestamp, r.Timestamp); err != nil {
			return fmt.Errorf("append link: %w", err)
		}
	}
	return batch.Send()
}

// UnlinkWallets marks the given wallets as unlinked (soft delete via
// unlinked_at). The next ReplacingMergeTree merge collapses rows.
func (c *Client) UnlinkWallets(ctx context.Context, wallets []string, ts time.Time) error {
	if len(wallets) == 0 {
		return nil
	}
	// We re-INSERT rows preserving existing (account_uid, linked_at) but with
	// unlinked_at set. Read-back-and-write keeps ORDER BY (wallet) semantics.
	rows, err := c.conn.Query(ctx, `
		SELECT wallet, account_uid, balance_ngonka, linked_at
		FROM gonka_vote.wallet_links FINAL
		WHERE wallet IN ? AND unlinked_at IS NULL
	`, wallets)
	if err != nil {
		return fmt.Errorf("select wallets to unlink: %w", err)
	}
	defer rows.Close()

	batch, err := c.conn.PrepareBatch(ctx,
		`INSERT INTO gonka_vote.wallet_links
		    (wallet, account_uid, balance_ngonka, linked_at, unlinked_at, updated_at)`)
	if err != nil {
		return fmt.Errorf("prepare unlink batch: %w", err)
	}
	var appended int
	for rows.Next() {
		var (
			wallet     string
			accountUID string
			balance    *big.Int
			linkedAt   time.Time
		)
		if err := rows.Scan(&wallet, &accountUID, &balance, &linkedAt); err != nil {
			return fmt.Errorf("scan unlink row: %w", err)
		}
		if balance == nil {
			balance = big.NewInt(0)
		}
		if err := batch.Append(wallet, accountUID, balance, linkedAt, ts, ts); err != nil {
			return fmt.Errorf("append unlink: %w", err)
		}
		appended++
	}
	if appended == 0 {
		return nil
	}
	return batch.Send()
}

// ListLinkedWallets returns wallets that are currently linked (not unlinked)
// along with the account_uid and previous linked_at (for preservation).
type LinkedWallet struct {
	Wallet     string
	AccountUID string
	LinkedAt   time.Time
}

func (c *Client) ListLinkedWallets(ctx context.Context) ([]LinkedWallet, error) {
	rows, err := c.conn.Query(ctx, `
		SELECT wallet, account_uid, linked_at
		FROM gonka_vote.wallet_links FINAL
		WHERE unlinked_at IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("list linked wallets: %w", err)
	}
	defer rows.Close()
	var out []LinkedWallet
	for rows.Next() {
		var lw LinkedWallet
		if err := rows.Scan(&lw.Wallet, &lw.AccountUID, &lw.LinkedAt); err != nil {
			return nil, err
		}
		out = append(out, lw)
	}
	return out, nil
}

// UpsertBalances writes fresh balance snapshots for the given wallets. Uses
// ListLinkedWallets output to preserve (account_uid, linked_at).
type BalanceUpdate struct {
	Wallet     string
	AccountUID string
	LinkedAt   time.Time
	Balance    *big.Int
}

func (c *Client) UpsertBalances(ctx context.Context, updates []BalanceUpdate) error {
	if len(updates) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		`INSERT INTO gonka_vote.wallet_links
		    (wallet, account_uid, balance_ngonka, linked_at, balance_refreshed_at, updated_at)`)
	if err != nil {
		return fmt.Errorf("prepare balances batch: %w", err)
	}
	now := time.Now().UTC()
	for _, u := range updates {
		bal := u.Balance
		if bal == nil {
			bal = big.NewInt(0)
		}
		if err := batch.Append(u.Wallet, u.AccountUID, bal, u.LinkedAt, now, now); err != nil {
			return fmt.Errorf("append balance: %w", err)
		}
	}
	return batch.Send()
}

func (c *Client) InsertSnapshots(ctx context.Context, rows []SnapshotRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		`INSERT INTO gonka_vote.vote_snapshots
		    (proposal_id, voter, amount_ngonka, weight_ngonka,
		     balance_ngonka, collateral_ngonka, vesting_ngonka, host_weight,
		     tx_hash, voted_at, refreshed_at)`)
	if err != nil {
		return fmt.Errorf("prepare snapshots batch: %w", err)
	}
	now := time.Now().UTC()
	zero := func(x *big.Int) *big.Int {
		if x == nil {
			return big.NewInt(0)
		}
		return x
	}
	for _, r := range rows {
		var votedAt *time.Time
		if !r.VotedAt.IsZero() {
			t := r.VotedAt
			votedAt = &t
		}
		if err := batch.Append(
			r.ProposalID,
			r.Voter,
			zero(r.AmountNgonka),
			zero(r.WeightNgonka),
			zero(r.BalanceNgonka),
			zero(r.CollateralNgonka),
			zero(r.VestingNgonka),
			zero(r.HostWeight),
			r.TxHash,
			votedAt,
			now,
		); err != nil {
			return fmt.Errorf("append snapshot: %w", err)
		}
	}
	return batch.Send()
}
