// Vote indexer for Gonka Vote.
//
// Periodically queries Tendermint tx_search for MsgExecuteContract txs
// targeting our voting contract, parses the {"vote":{...}} payload, and
// writes votes to ClickHouse.
//
// In parallel, refreshes per-voter ngonka balance snapshots used by the
// frontend to display weighted tallies.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"github.com/gonka/vote/indexer/internal/balance_refresher"
	"github.com/gonka/vote/indexer/internal/clickhouse"
	"github.com/gonka/vote/indexer/internal/config"
	"github.com/gonka/vote/indexer/internal/link_scanner"
	"github.com/gonka/vote/indexer/internal/logger"
	"github.com/gonka/vote/indexer/internal/rpc"
)

func main() {
	_ = godotenv.Load()

	l := logger.New()
	defer l.Sync()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	l.Infow("starting vote indexer",
		"rpc_url", cfg.RPCURL,
		"rest_url", cfg.ChainAPIURL,
		"link_contract", cfg.LinkContractAddress,
		"clickhouse", cfg.ClickHouse.Host,
		"scan_interval", cfg.ScanInterval,
		"balance_refresh_interval", cfg.BalanceRefreshInterval,
	)

	ch, err := clickhouse.New(cfg.ClickHouse)
	if err != nil {
		log.Fatalf("clickhouse: %v", err)
	}
	defer ch.Close()

	rpcClient := rpc.New(cfg.RPCURL, cfg.ChainAPIURL, cfg.TrackerAPIURL, cfg.HTTPTimeout)

	linkSc := link_scanner.New(cfg, rpcClient, ch, l)
	balRef := balance_refresher.New(cfg, rpcClient, ch, l)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go linkSc.Run(ctx)
	go balRef.Run(ctx)
	go runHealthServer(ctx, cfg.HealthAddr, ch, linkSc, balRef, l.Named("health"))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	l.Info("shutting down")
	cancel()
}

// runHealthServer exposes /health for docker healthcheck and /refresh for
// on-demand per-user re-scan of contract links + wallet balances. /refresh is
// rate-limited to 6 calls/minute across the whole server (sliding window) so
// a spammy client can't melt the chain RPC or the tx_search endpoint.
func runHealthServer(
	ctx context.Context,
	addr string,
	ch *clickhouse.Client,
	linkSc *link_scanner.Scanner,
	balRef *balance_refresher.Refresher,
	l interface {
		Warnw(msg string, keysAndValues ...interface{})
		Infow(msg string, keysAndValues ...interface{})
	},
) {
	rl := &slidingWindow{limit: 6, window: time.Minute}
	uidRE := regexp.MustCompile(`^u_[a-f0-9]{8}$`)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		c, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := ch.Ping(c); err != nil {
			http.Error(w, "clickhouse unreachable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		uid := r.URL.Query().Get("uid")
		if !uidRE.MatchString(uid) {
			http.Error(w, "invalid uid", http.StatusBadRequest)
			return
		}
		if !rl.Allow() {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		c, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		linkSc.TickOnce(c)
		n, err := balRef.RefreshUID(c, uid)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		l.Infow("manual refresh", "uid", uid, "wallets", n)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"wallets":` + itoa(n) + `}`))
	})

	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		l.Warnw("health server stopped", "err", err)
	}
}

type slidingWindow struct {
	mu     sync.Mutex
	hits   []time.Time
	limit  int
	window time.Duration
}

func (s *slidingWindow) Allow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-s.window)
	i := 0
	for ; i < len(s.hits); i++ {
		if s.hits[i].After(cutoff) {
			break
		}
	}
	s.hits = s.hits[i:]
	if len(s.hits) >= s.limit {
		return false
	}
	s.hits = append(s.hits, now)
	return true
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
