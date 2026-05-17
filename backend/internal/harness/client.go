package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	httpClient *http.Client
}

func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 600 * time.Second},
	}
}

type createSessionResponse struct {
	ID string `json:"id"`
}

func (c *Client) CreateSession(ctx context.Context, sandboxURL string) (string, error) {
	resp, err := c.httpClient.Post(sandboxURL+"/session", "application/json", bytes.NewBufferString("{}"))
	if err != nil {
		return "", fmt.Errorf("harness create session: %w", err)
	}
	defer resp.Body.Close()
	var result createSessionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.ID, nil
}

type messagePart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type sendMessageRequest struct {
	Parts []messagePart `json:"parts"`
}

func (c *Client) SendMessage(ctx context.Context, sandboxURL, harnessSessionID, text string) (json.RawMessage, error) {
	body, _ := json.Marshal(sendMessageRequest{
		Parts: []messagePart{{Type: "text", Text: text}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/session/%s/message", sandboxURL, harnessSessionID),
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("harness send message: %w", err)
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (c *Client) WaitHTTPReady(ctx context.Context, sandboxURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(sandboxURL + "/session")
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			return nil
		}
		if resp != nil {
			resp.Body.Close()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("timeout waiting for harness HTTP at %s", sandboxURL)
}

// StreamEvents opens the SSE /event endpoint on the sandbox and pipes raw bytes to w.
func (c *Client) StreamEvents(ctx context.Context, sandboxURL, harnessSessionID string, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sandboxURL+"/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, err = io.Copy(w, resp.Body)
	return err
}
