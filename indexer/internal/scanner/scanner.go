// Package scanner periodically pulls successful MsgExecuteContract txs that
// target our contract via Tendermint tx_search and writes votes into
// ClickHouse. Vote metadata (tender_id, voter, amount) is read directly from
// the tx events emitted by the contract — no extra REST fetch needed.
package scanner

import (
	"context"
	"math/big"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/gonka/vote/indexer/internal/clickhouse"
	"github.com/gonka/vote/indexer/internal/config"
	"github.com/gonka/vote/indexer/internal/rpc"
)

const checkpointTask = "scanner"

type Scanner struct {
	cfg *config.Config
	rpc *rpc.Client
	ch  *clickhouse.Client
	log *zap.SugaredLogger
}

func New(cfg *config.Config, r *rpc.Client, ch *clickhouse.Client, log *zap.SugaredLogger) *Scanner {
	return &Scanner{cfg: cfg, rpc: r, ch: ch, log: log}
}

func (s *Scanner) Run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.ScanInterval)
	defer ticker.Stop()

	s.tickOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tickOnce(ctx)
		}
	}
}

func (s *Scanner) tickOnce(ctx context.Context) {
	checkpoint, err := s.ch.GetCheckpoint(ctx, checkpointTask)
	if err != nil {
		s.log.Errorw("checkpoint read failed", "err", err)
		return
	}

	minHeight := checkpoint
	if minHeight > 1 {
		minHeight-- // 1 block of overlap to absorb late-indexed tx
	}

	hits, err := s.rpc.SearchExecuteContractTxs(ctx, s.cfg.ContractAddress, minHeight)
	if err != nil {
		s.log.Errorw("tx_search failed", "err", err)
		return
	}
	if len(hits) == 0 {
		return
	}

	now := time.Now().UTC()
	rows := make([]clickhouse.VoteRow, 0, len(hits))
	maxHeight := checkpoint
	for _, h := range hits {
		vr, ok := s.parseVoteEvents(h, now)
		if !ok {
			continue
		}
		rows = append(rows, vr)
		if h.Height > maxHeight {
			maxHeight = h.Height
		}
	}

	if len(rows) > 0 {
		if err := s.ch.InsertVotes(ctx, rows); err != nil {
			s.log.Errorw("insert votes failed", "err", err)
			return
		}
		s.log.Infow("indexed votes", "count", len(rows), "max_height", maxHeight)
	}

	if maxHeight > checkpoint {
		if err := s.ch.SetCheckpoint(ctx, checkpointTask, maxHeight); err != nil {
			s.log.Errorw("checkpoint write failed", "err", err)
		}
	}
}

// parseVoteEvents extracts a VoteRow from the `wasm` event attributes emitted
// by the contract's `vote` action. Contract wire format still uses `tender_id`.
func (s *Scanner) parseVoteEvents(h rpc.TxSearchResult, ts time.Time) (clickhouse.VoteRow, bool) {
	for _, ev := range h.Events {
		if ev.Type != "wasm" {
			continue
		}
		attrs := map[string]string{}
		for _, a := range ev.Attributes {
			attrs[a.Key] = a.Value
		}
		if !strings.EqualFold(attrs["_contract_address"], s.cfg.ContractAddress) {
			continue
		}
		if attrs["action"] != "vote" {
			continue
		}
		proposalID := attrs["tender_id"]
		voter := attrs["voter"]
		amount := attrs["amount"]
		if proposalID == "" || voter == "" || amount == "" {
			continue
		}
		amt, ok := new(big.Int).SetString(amount, 10)
		if !ok || amt.Sign() <= 0 {
			continue
		}
		return clickhouse.VoteRow{
			ProposalID:   proposalID,
			Voter:        voter,
			AmountNgonka: amt,
			Height:       h.Height,
			TxHash:       h.Hash,
			Timestamp:    ts,
		}, true
	}
	return clickhouse.VoteRow{}, false
}
