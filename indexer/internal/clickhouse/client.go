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
	TenderID     string
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
		`INSERT INTO gonka_vote.votes (tender_id, voter, amount_ngonka, height, tx_hash, timestamp)`)
	if err != nil {
		return fmt.Errorf("prepare votes batch: %w", err)
	}
	for _, r := range rows {
		amt := r.AmountNgonka
		if amt == nil {
			amt = big.NewInt(0)
		}
		if err := batch.Append(r.TenderID, r.Voter, amt, r.Height, r.TxHash, r.Timestamp); err != nil {
			return fmt.Errorf("append vote: %w", err)
		}
	}
	return batch.Send()
}

// ListOpenTenderVoters returns (tender_id, voter, amount_ngonka, tx_hash,
// voted_at) for OPEN tenders. Used by snapshot refresher.
type VoterRow struct {
	TenderID     string
	Voter        string
	AmountNgonka *big.Int
	TxHash       string
	VotedAt      time.Time
}

func (c *Client) ListOpenTenderVoters(ctx context.Context) ([]VoterRow, error) {
	rows, err := c.conn.Query(ctx, `
		SELECT v.tender_id, v.voter, v.amount_ngonka, v.tx_hash, v.timestamp
		FROM gonka_vote.votes v FINAL
		WHERE v.tender_id IN (
			SELECT toString(id) FROM gonka_vote.tenders FINAL
			WHERE status = 'open' AND deleted_at IS NULL
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("list voters: %w", err)
	}
	defer rows.Close()

	var out []VoterRow
	for rows.Next() {
		var (
			tenderID string
			voter    string
			amount   *big.Int
			txHash   string
			votedAt  time.Time
		)
		if err := rows.Scan(&tenderID, &voter, &amount, &txHash, &votedAt); err != nil {
			return nil, err
		}
		out = append(out, VoterRow{
			TenderID: tenderID, Voter: voter, AmountNgonka: amount,
			TxHash: txHash, VotedAt: votedAt,
		})
	}
	return out, rows.Err()
}

// ----------------------------------------------------------------------------
// Vote snapshots
// ----------------------------------------------------------------------------

type SnapshotRow struct {
	TenderID         string
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

func (c *Client) InsertSnapshots(ctx context.Context, rows []SnapshotRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		`INSERT INTO gonka_vote.vote_snapshots
		    (tender_id, voter, amount_ngonka, weight_ngonka,
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
			r.TenderID,
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
