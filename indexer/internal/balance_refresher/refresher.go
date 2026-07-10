// Package balance_refresher periodically refreshes GNK balances for every
// linked wallet in wallet_links. Runs once per BalanceRefreshInterval. Uses
// the same retry-with-exponential-backoff strategy as the legacy snapshot
// pipeline. Wallets with fetch failures keep their previous balance.
package balance_refresher

import (
	"context"
	"math/big"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/gonka/vote/indexer/internal/clickhouse"
	"github.com/gonka/vote/indexer/internal/config"
	"github.com/gonka/vote/indexer/internal/rpc"
)

type Refresher struct {
	cfg *config.Config
	rpc *rpc.Client
	ch  *clickhouse.Client
	log *zap.SugaredLogger
}

func New(cfg *config.Config, r *rpc.Client, ch *clickhouse.Client, log *zap.SugaredLogger) *Refresher {
	return &Refresher{cfg: cfg, rpc: r, ch: ch, log: log}
}

func (r *Refresher) Run(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.BalanceRefreshInterval)
	defer ticker.Stop()

	r.tickOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.tickOnce(ctx)
		}
	}
}

func (r *Refresher) tickOnce(ctx context.Context) {
	wallets, err := r.ch.ListLinkedWallets(ctx)
	if err != nil {
		r.log.Errorw("list linked wallets failed", "err", err)
		return
	}
	if len(wallets) == 0 {
		return
	}

	sem := make(chan struct{}, r.cfg.BalanceConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	updates := make([]clickhouse.BalanceUpdate, 0, len(wallets))

	for _, lw := range wallets {
		lw := lw
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			bal, err := retryBalance(ctx, func() (*big.Int, error) {
				return r.rpc.GetNgonkaBalance(ctx, lw.Wallet)
			})
			if err != nil {
				r.log.Warnw("balance fetch failed", "wallet", lw.Wallet, "err", err)
				return
			}
			mu.Lock()
			updates = append(updates, clickhouse.BalanceUpdate{
				Wallet:     lw.Wallet,
				AccountUID: lw.AccountUID,
				LinkedAt:   lw.LinkedAt,
				Balance:    bal,
			})
			mu.Unlock()
		}()
	}
	wg.Wait()

	if err := r.ch.UpsertBalances(ctx, updates); err != nil {
		r.log.Errorw("upsert balances failed", "err", err)
		return
	}
	r.log.Infow("balances refreshed", "wallets", len(wallets), "updated", len(updates))
}

func retryBalance(ctx context.Context, fn func() (*big.Int, error)) (*big.Int, error) {
	const maxAttempts = 10
	delay := time.Second
	var last error
	for i := 0; i < maxAttempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
			delay *= 2
		}
		v, err := fn()
		if err == nil {
			return v, nil
		}
		last = err
	}
	return nil, last
}
