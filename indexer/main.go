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
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"github.com/gonka/vote/indexer/internal/clickhouse"
	"github.com/gonka/vote/indexer/internal/config"
	"github.com/gonka/vote/indexer/internal/logger"
	"github.com/gonka/vote/indexer/internal/rpc"
	"github.com/gonka/vote/indexer/internal/scanner"
	"github.com/gonka/vote/indexer/internal/snapshot"
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
		"contract", cfg.ContractAddress,
		"clickhouse", cfg.ClickHouse.Host,
		"scan_interval", cfg.ScanInterval,
		"snapshot_interval", cfg.SnapshotInterval,
	)

	ch, err := clickhouse.New(cfg.ClickHouse)
	if err != nil {
		log.Fatalf("clickhouse: %v", err)
	}
	defer ch.Close()

	rpcClient := rpc.New(cfg.RPCURL, cfg.ChainAPIURL, cfg.TrackerAPIURL, cfg.HTTPTimeout)

	sc := scanner.New(cfg, rpcClient, ch, l)
	snap := snapshot.New(cfg, rpcClient, ch, l)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go sc.Run(ctx)
	go snap.Run(ctx)
	go runHealthServer(ctx, cfg.HealthAddr, ch, l.Named("health"))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	l.Info("shutting down")
	cancel()
}

// runHealthServer exposes /health for docker healthcheck. Returns 200 if the
// ClickHouse ping succeeds, 503 otherwise.
func runHealthServer(ctx context.Context, addr string, ch *clickhouse.Client, l interface {
	Warnw(msg string, keysAndValues ...interface{})
}) {
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
