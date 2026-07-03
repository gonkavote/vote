// Package rpc is a tiny Tendermint RPC + Cosmos REST client tailored for the
// vote indexer. Adapted from gonka tracker/tx-scanner/internal/rpc/client.go.
package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type Client struct {
	rpcURL     string
	restURL    string
	trackerURL string
	http       *http.Client
}

func New(rpcURL, restURL, trackerURL string, timeout time.Duration) *Client {
	transport := &http.Transport{
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
		MaxConnsPerHost:       50,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &Client{
		rpcURL:     rpcURL,
		restURL:    restURL,
		trackerURL: trackerURL,
		http:       &http.Client{Timeout: timeout, Transport: transport},
	}
}

// ----------------------------------------------------------------------------
// Tendermint RPC: tx_search
// ----------------------------------------------------------------------------

type TxEventAttr struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type TxEvent struct {
	Type       string        `json:"type"`
	Attributes []TxEventAttr `json:"attributes"`
}

type TxSearchResult struct {
	Hash    string
	Height  uint64
	TxIndex uint32
	Code    int
	RawLog  string
	Events  []TxEvent
}

func (c *Client) SearchExecuteContractTxs(
	ctx context.Context,
	contractAddr string,
	minHeight uint64,
) ([]TxSearchResult, error) {
	const perPage = 100
	out := []TxSearchResult{}

	page := 1
	for {
		query := fmt.Sprintf(
			`execute._contract_address='%s' AND tx.height>=%d`,
			contractAddr, minHeight,
		)
		u := fmt.Sprintf(
			"%s/tx_search?query=%s&prove=false&order_by=%s&page=%d&per_page=%d",
			c.rpcURL,
			url.QueryEscape(`"`+query+`"`),
			url.QueryEscape(`"asc"`),
			page,
			perPage,
		)

		body, err := c.getJSON(ctx, u)
		if err != nil {
			return nil, fmt.Errorf("tx_search: %w", err)
		}

		var resp struct {
			Result struct {
				Txs []struct {
					Hash     string `json:"hash"`
					Height   string `json:"height"`
					Index    uint32 `json:"index"`
					TxResult struct {
						Code   int       `json:"code"`
						Log    string    `json:"log"`
						Events []TxEvent `json:"events"`
					} `json:"tx_result"`
				} `json:"txs"`
				TotalCount string `json:"total_count"`
			} `json:"result"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, fmt.Errorf("decode tx_search: %w", err)
		}
		if len(resp.Result.Txs) == 0 {
			break
		}
		for _, tx := range resp.Result.Txs {
			if tx.TxResult.Code != 0 {
				continue
			}
			h, _ := strconv.ParseUint(tx.Height, 10, 64)
			out = append(out, TxSearchResult{
				Hash:    tx.Hash,
				Height:  h,
				TxIndex: tx.Index,
				Code:    tx.TxResult.Code,
				RawLog:  tx.TxResult.Log,
				Events:  tx.TxResult.Events,
			})
		}
		total, _ := strconv.Atoi(resp.Result.TotalCount)
		if page*perPage >= total {
			break
		}
		page++
	}
	return out, nil
}

// ----------------------------------------------------------------------------
// Cosmos REST: balance lookup
// ----------------------------------------------------------------------------

// GetNgonkaBalance returns the ngonka balance for an address. Returns 0 on
// missing balance.
func (c *Client) GetNgonkaBalance(ctx context.Context, addr string) (*big.Int, error) {
	u := fmt.Sprintf("%s/cosmos/bank/v1beta1/balances/%s/by_denom?denom=ngonka", c.restURL, addr)
	body, err := c.getJSON(ctx, u)
	if err != nil {
		return nil, fmt.Errorf("balance %s: %w", addr, err)
	}
	var resp struct {
		Balance struct {
			Amount string `json:"amount"`
		} `json:"balance"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode balance %s: %w", addr, err)
	}
	if resp.Balance.Amount == "" {
		return big.NewInt(0), nil
	}
	n, ok := new(big.Int).SetString(resp.Balance.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid balance amount %q for %s", resp.Balance.Amount, addr)
	}
	return n, nil
}

// GetVesting returns the total vesting balance in ngonka. Empty list = 0.
func (c *Client) GetVesting(ctx context.Context, addr string) (*big.Int, error) {
	u := fmt.Sprintf("%s/productscience/inference/streamvesting/total_vesting/%s", c.restURL, addr)
	body, err := c.getJSON(ctx, u)
	if err != nil {
		return big.NewInt(0), nil
	}
	var resp struct {
		TotalAmount []struct {
			Denom  string `json:"denom"`
			Amount string `json:"amount"`
		} `json:"total_amount"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return big.NewInt(0), nil
	}
	for _, c := range resp.TotalAmount {
		if c.Denom == "ngonka" {
			n, ok := new(big.Int).SetString(c.Amount, 10)
			if ok {
				return n, nil
			}
		}
	}
	return big.NewInt(0), nil
}

// CurrentEpoch returns the current epoch_id from the tracker. 0 on failure.
func (c *Client) CurrentEpoch(ctx context.Context) uint64 {
	if c.trackerURL == "" {
		return 0
	}
	body, err := c.getJSON(ctx, c.trackerURL+"/inference/current")
	if err != nil {
		return 0
	}
	var resp struct {
		EpochID uint64 `json:"epoch_id"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0
	}
	return resp.EpochID
}

// GetHostWeight returns the participant's effective voting weight for the
// given epoch. Mirrors tracker's "active weight" rule (see App.tsx:445-460):
//
//   - participant_status == "INACTIVE"  → 0  (the host left / was slashed)
//   - weight_to_confirm    == 0          → weight  (PoC-slot-only host —
//                                                   not required to confirm
//                                                   in CPoC, full weight)
//   - otherwise                          → confirmation_weight  (what they
//                                                                actually
//                                                                confirmed)
//
// Non-host (404), missing fields, network errors → 0. Result is rounded
// down to integer; we store host_weight as UInt128 unscaled.
func (c *Client) GetHostWeight(ctx context.Context, addr string, epoch uint64) *big.Int {
	if c.trackerURL == "" || epoch == 0 {
		return big.NewInt(0)
	}
	u := fmt.Sprintf("%s/participants/%s?epoch_id=%d", c.trackerURL, addr, epoch)
	body, err := c.getJSON(ctx, u)
	if err != nil {
		return big.NewInt(0)
	}
	var resp struct {
		Participant struct {
			Weight              uint64  `json:"weight"`
			WeightToConfirm     *uint64 `json:"weight_to_confirm"`
			ConfirmationWeight  *uint64 `json:"confirmation_weight"`
			ParticipantStatus   string  `json:"participant_status"`
		} `json:"participant"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return big.NewInt(0)
	}
	p := resp.Participant
	if p.ParticipantStatus == "INACTIVE" || p.Weight == 0 {
		return big.NewInt(0)
	}
	// PoC-slot-only: tracker treats null and 0 the same (no CPoC obligation).
	if p.WeightToConfirm == nil || *p.WeightToConfirm == 0 {
		return new(big.Int).SetUint64(p.Weight)
	}
	if p.ConfirmationWeight == nil {
		return big.NewInt(0)
	}
	return new(big.Int).SetUint64(*p.ConfirmationWeight)
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

func (c *Client) getJSON(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

// DecodeBase64 is a small helper for Tendermint event values which are base64.
func DecodeBase64(s string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return "", errors.New("invalid base64")
	}
	return string(b), nil
}
