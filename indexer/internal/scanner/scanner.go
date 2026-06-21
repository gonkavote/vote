// Package scanner periodically pulls successful MsgExecuteContract txs that
// target our contract via Tendermint tx_search, parses the {"vote": {...}}
// payload and writes votes into ClickHouse.
package scanner

import (
	"context"
	"encoding/json"
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

	rows := make([]clickhouse.VoteRow, 0, len(hits))
	maxHeight := checkpoint
	for _, h := range hits {
		msgs, ts, _, err := s.rpc.FetchTxBody(ctx, h.Hash)
		if err != nil {
			s.log.Warnw("fetch tx body failed", "hash", h.Hash, "err", err)
			continue
		}
		for _, m := range msgs {
			vr, ok := s.parseVoteMsg(m, h.Hash, h.Height, ts)
			if !ok {
				continue
			}
			rows = append(rows, vr)
		}
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

// parseVoteMsg extracts a VoteRow from a single decoded Cosmos message JSON
// if it matches our contract and {"vote": {...}} payload.
func (s *Scanner) parseVoteMsg(raw json.RawMessage, txHash string, height uint64, ts time.Time) (clickhouse.VoteRow, bool) {
	var m struct {
		Type     string          `json:"@type"`
		Sender   string          `json:"sender"`
		Contract string          `json:"contract"`
		Msg      json.RawMessage `json:"msg"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return clickhouse.VoteRow{}, false
	}
	if m.Type != "/cosmwasm.wasm.v1.MsgExecuteContract" {
		return clickhouse.VoteRow{}, false
	}
	if !strings.EqualFold(m.Contract, s.cfg.ContractAddress) {
		return clickhouse.VoteRow{}, false
	}

	var action map[string]json.RawMessage
	if err := json.Unmarshal(m.Msg, &action); err != nil {
		return clickhouse.VoteRow{}, false
	}
	voteRaw, ok := action["vote"]
	if !ok {
		return clickhouse.VoteRow{}, false
	}
	var vote struct {
		TenderID string `json:"tender_id"`
		Amount   string `json:"amount"` // Uint128 serializes as string
	}
	if err := json.Unmarshal(voteRaw, &vote); err != nil {
		return clickhouse.VoteRow{}, false
	}
	if vote.TenderID == "" || vote.Amount == "" {
		return clickhouse.VoteRow{}, false
	}
	amt, ok := new(big.Int).SetString(vote.Amount, 10)
	if !ok || amt.Sign() <= 0 {
		return clickhouse.VoteRow{}, false
	}

	return clickhouse.VoteRow{
		TenderID:     vote.TenderID,
		Voter:        m.Sender,
		AmountNgonka: amt,
		Height:       height,
		TxHash:       txHash,
		Timestamp:    ts,
	}, true
}
