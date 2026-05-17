package harness

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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

func (c *Client) PromptAsync(ctx context.Context, sandboxURL, harnessSessionID, text string) error {
	body, _ := json.Marshal(sendMessageRequest{
		Parts: []messagePart{{Type: "text", Text: text}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/session/%s/prompt_async", sandboxURL, harnessSessionID),
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("harness prompt_async: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("harness prompt_async status %d: %s", resp.StatusCode, b)
	}
	return nil
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

// StreamEvents opens the SSE /event endpoint, filters by harnessSessionID, and forwards matching events to w.
// Each forwarded event is written as "data: <json>\n\n".
func (c *Client) StreamEvents(ctx context.Context, sandboxURL, harnessSessionID string, w io.Writer) error {
	// no timeout for the SSE stream connection itself
	streamClient := &http.Client{}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sandboxURL+"/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := streamClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	var dataLine string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			dataLine = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			continue
		}
		if line == "" && dataLine != "" {
			// filter by session
			if harnessSessionID == "" || strings.Contains(dataLine, harnessSessionID) {
				fmt.Fprintf(w, "data: %s\n\n", dataLine)
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
			}
			dataLine = ""
		}
	}
	return scanner.Err()
}
