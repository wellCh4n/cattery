package harness

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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

func (c *Client) Abort(ctx context.Context, sandboxURL, harnessSessionID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/session/%s/abort", sandboxURL, harnessSessionID), nil,
	)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("harness abort: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("harness abort status %d: %s", resp.StatusCode, b)
	}
	return nil
}

// History 拉取 harness 内的历史消息原文（数组），原样返回 JSON。
func (c *Client) History(ctx context.Context, sandboxURL, harnessSessionID string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/session/%s/message", sandboxURL, harnessSessionID), nil,
	)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("harness history: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("harness history status %d: %s", resp.StatusCode, b)
	}
	return io.ReadAll(resp.Body)
}

// GetSession 拉取 harness 内 session 的元信息（用于读取 title 等字段）
func (c *Client) GetSession(ctx context.Context, sandboxURL, harnessSessionID string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/session/%s", sandboxURL, harnessSessionID), nil,
	)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("harness get session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("harness get session status %d: %s", resp.StatusCode, b)
	}
	var info map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return info, nil
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

// StreamEventsUntilIdle 连接 sandbox /event SSE，将原始事件翻译为平台统一格式后写入 w，
// 直到 primary session 进入 idle 状态。onEvent（可选）在每个平台事件被转发前调用，
// 调用方可借此把感兴趣的事件落库。
func (c *Client) StreamEventsUntilIdle(ctx context.Context, sandboxURL, harnessSessionID string, w io.Writer, onEvent func(*PlatformEvent)) error {
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

	childSessions := map[string]bool{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var dataLine string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			dataLine = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			continue
		}
		if line != "" || dataLine == "" {
			continue
		}
		// 空行 = 事件结束，处理 dataLine
		log.Printf("[harness] raw event: %s", dataLine)
		platEv, isIdle := translateOpencode(dataLine, harnessSessionID, childSessions)
		log.Printf("[harness] translated: platEv=%v isIdle=%v", platEv, isIdle)
		dataLine = ""

		if platEv != nil {
			if onEvent != nil {
				onEvent(platEv)
			}
			b, _ := json.Marshal(platEv)
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if isIdle {
			return nil
		}
	}
	return scanner.Err()
}
