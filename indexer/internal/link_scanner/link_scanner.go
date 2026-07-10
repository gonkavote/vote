// Package link_scanner periodically pulls successful MsgExecuteContract txs
// that target the wallet-link contract via Tendermint tx_search. Extracts
// (wallet, account_uid) from `link_account` events and (wallet) from
// `unlink_account` events, writes into ClickHouse `wallet_links`.
package link_scanner

import (
	"context"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/gonka/vote/indexer/internal/clickhouse"
	"github.com/gonka/vote/indexer/internal/config"
	"github.com/gonka/vote/indexer/internal/rpc"
)

const checkpointTask = "link_scanner"

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
	if s.cfg.LinkContractAddress == "" {
		s.log.Warn("LINK_CONTRACT_ADDRESS is empty — link_scanner disabled")
		return
	}
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
		minHeight--
	}

	hits, err := s.rpc.SearchExecuteContractTxs(ctx, s.cfg.LinkContractAddress, minHeight)
	if err != nil {
		s.log.Errorw("link tx_search failed", "err", err)
		return
	}
	if len(hits) == 0 {
		return
	}

	now := time.Now().UTC()
	var links []clickhouse.LinkRow
	var unlinks []string
	maxHeight := checkpoint
	for _, h := range hits {
		s.parseLinkEvents(h, now, &links, &unlinks)
		if h.Height > maxHeight {
			maxHeight = h.Height
		}
	}

	if len(links) > 0 {
		if err := s.ch.UpsertWalletLinks(ctx, links); err != nil {
			s.log.Errorw("upsert wallet_links failed", "err", err)
			return
		}
	}
	if len(unlinks) > 0 {
		if err := s.ch.UnlinkWallets(ctx, unlinks, now); err != nil {
			s.log.Errorw("unlink wallets failed", "err", err)
			return
		}
	}
	if len(links) > 0 || len(unlinks) > 0 {
		s.log.Infow("indexed wallet links",
			"linked", len(links), "unlinked", len(unlinks), "max_height", maxHeight)
	}

	if maxHeight > checkpoint {
		if err := s.ch.SetCheckpoint(ctx, checkpointTask, maxHeight); err != nil {
			s.log.Errorw("link checkpoint write failed", "err", err)
		}
	}
}

// parseLinkEvents scans a tx's wasm events for our contract and extracts
// link/unlink attributes emitted by the contract.
func (s *Scanner) parseLinkEvents(h rpc.TxSearchResult, ts time.Time, links *[]clickhouse.LinkRow, unlinks *[]string) {
	for _, ev := range h.Events {
		if ev.Type != "wasm" {
			continue
		}
		attrs := map[string]string{}
		for _, a := range ev.Attributes {
			attrs[a.Key] = a.Value
		}
		if !strings.EqualFold(attrs["_contract_address"], s.cfg.LinkContractAddress) {
			continue
		}
		action := attrs["action"]
		wallet := attrs["wallet"]
		if wallet == "" {
			continue
		}
		switch action {
		case "link_account":
			uid := attrs["account_uid"]
			if uid == "" {
				continue
			}
			*links = append(*links, clickhouse.LinkRow{
				Wallet:     wallet,
				AccountUID: uid,
				Height:     h.Height,
				Timestamp:  ts,
			})
		case "unlink_account":
			*unlinks = append(*unlinks, wallet)
		}
	}
}
