package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	RPCURL          string
	ChainAPIURL     string
	TrackerAPIURL   string
	ContractAddress string
	HTTPTimeout     time.Duration

	ScanInterval       time.Duration
	SnapshotInterval   time.Duration
	BalanceConcurrency int

	HealthAddr string

	ClickHouse ClickHouseConfig
}

type ClickHouseConfig struct {
	Host     string
	Port     int
	Database string
	User     string
	Password string
}

// Load reads configuration from the environment. Endpoints, contract and
// chain identity are REQUIRED — there are no production fallbacks, so a
// missing .env fails fast at startup with a clear message listing every
// missing variable.
func Load() (*Config, error) {
	cfg := &Config{
		RPCURL:             os.Getenv("RPC_URL"),
		ChainAPIURL:        os.Getenv("CHAIN_API_URL"),
		TrackerAPIURL:      os.Getenv("TRACKER_API_URL"),
		ContractAddress:    os.Getenv("CONTRACT_ADDRESS"),
		HTTPTimeout:        envDuration("HTTP_TIMEOUT", 30*time.Second),
		ScanInterval:       envDuration("SCAN_INTERVAL", 15*time.Second),
		SnapshotInterval:   envDuration("SNAPSHOT_INTERVAL", 60*time.Second),
		BalanceConcurrency: envInt("BALANCE_CONCURRENCY", 10),
		HealthAddr:         env("HEALTH_ADDR", ":8080"),
		ClickHouse: ClickHouseConfig{
			Host:     env("CLICKHOUSE_HOST", "clickhouse"),
			Port:     envInt("CLICKHOUSE_PORT", 9000),
			Database: env("CLICKHOUSE_DATABASE", "gonka_vote"),
			User:     env("CLICKHOUSE_USER", "default"),
			Password: os.Getenv("CLICKHOUSE_PASSWORD"),
		},
	}

	var missing []string
	if cfg.RPCURL == "" {
		missing = append(missing, "RPC_URL")
	}
	if cfg.ChainAPIURL == "" {
		missing = append(missing, "CHAIN_API_URL")
	}
	if cfg.TrackerAPIURL == "" {
		missing = append(missing, "TRACKER_API_URL")
	}
	if cfg.ContractAddress == "" {
		missing = append(missing, "CONTRACT_ADDRESS")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf(
			"missing required environment variables: %s (see .env.template)",
			strings.Join(missing, ", "),
		)
	}
	return cfg, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
