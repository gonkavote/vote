// Package snapshot periodically polls per-voter wealth + host weight for
// every voter on OPEN proposals and writes weighted snapshots into ClickHouse.
package snapshot

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

func (s *Refresher) Run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.SnapshotInterval)
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

// voterWeights bundles all per-voter metrics gathered for one snapshot.
type voterWeights struct {
	balance    *big.Int
	collateral *big.Int
	vesting    *big.Int
	hostWeight *big.Int
}

func (vw voterWeights) community() *big.Int {
	out := new(big.Int).Add(vw.balance, vw.collateral)
	return out.Add(out, vw.vesting)
}

func (s *Refresher) tickOnce(ctx context.Context) {
	voters, err := s.ch.ListOpenProposalVoters(ctx)
	if err != nil {
		s.log.Errorw("list voters failed", "err", err)
		return
	}
	if len(voters) == 0 {
		return
	}

	// Deduplicate per-address lookups: same voter may appear in many proposals.
	addrSet := make(map[string]struct{}, len(voters))
	for _, v := range voters {
		addrSet[v.Voter] = struct{}{}
	}
	addrs := make([]string, 0, len(addrSet))
	for a := range addrSet {
		addrs = append(addrs, a)
	}

	// Fetch the current epoch once — host weight is per-epoch.
	epoch := s.rpc.CurrentEpoch(ctx)
	if epoch == 0 {
		s.log.Warnw("tracker current epoch unavailable, host_weight will be 0")
	}

	weights := s.fetchWeights(ctx, addrs, epoch)

	rows := make([]clickhouse.SnapshotRow, 0, len(voters))
	for _, v := range voters {
		w := weights[v.Voter]
		rows = append(rows, clickhouse.SnapshotRow{
			ProposalID:          v.ProposalID,
			Voter:             v.Voter,
			AmountNgonka:      v.AmountNgonka,
			WeightNgonka:      w.community(),
			BalanceNgonka:     w.balance,
			CollateralNgonka:  w.collateral,
			VestingNgonka:     w.vesting,
			HostWeight:        w.hostWeight,
			TxHash:            v.TxHash,
			VotedAt:           v.VotedAt,
		})
	}

	if err := s.ch.InsertSnapshots(ctx, rows); err != nil {
		s.log.Errorw("insert snapshots failed", "err", err)
		return
	}
	s.log.Infow("snapshot refreshed",
		"voters", len(addrs), "rows", len(rows), "epoch", epoch)
}

// fetchWeights pulls balance + collateral + vesting + host_weight for every
// address concurrently (bounded by BalanceConcurrency). Failures fall back
// to zero so the snapshot always succeeds.
func (s *Refresher) fetchWeights(ctx context.Context, addrs []string, epoch uint64) map[string]voterWeights {
	out := make(map[string]voterWeights, len(addrs))
	var mu sync.Mutex

	sem := make(chan struct{}, s.cfg.BalanceConcurrency)
	var wg sync.WaitGroup
	for _, a := range addrs {
		a := a
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			vw := s.fetchOne(ctx, a, epoch)
			mu.Lock()
			out[a] = vw
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out
}

func (s *Refresher) fetchOne(ctx context.Context, addr string, epoch uint64) voterWeights {
	bal, err := s.rpc.GetNgonkaBalance(ctx, addr)
	if err != nil {
		s.log.Warnw("balance fetch failed", "addr", addr, "err", err)
		bal = big.NewInt(0)
	}
	col, err := s.rpc.GetCollateral(ctx, addr)
	if err != nil {
		col = big.NewInt(0)
	}
	vest, err := s.rpc.GetVesting(ctx, addr)
	if err != nil {
		vest = big.NewInt(0)
	}
	hw := s.rpc.GetHostWeight(ctx, addr, epoch)

	return voterWeights{
		balance:    bal,
		collateral: col,
		vesting:    vest,
		hostWeight: hw,
	}
}
