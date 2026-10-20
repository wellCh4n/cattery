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

// AgentModel is the model a session runs on, with the endpoint and key the
// agent should reach it through. Provider is a pi-ai provider id.
type AgentModel struct {
	ID       string `json:"model"`
	Provider string `json:"provider"`
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey"`
	// ThinkingLevel is the session's effort (a pi thinking level).
	ThinkingLevel string `json:"thinkingLevel"`
}

// CreateSession 在 sandbox 内创建（或确认已存在）一个 agent session。agent 用
// 平台的 session id 作为 transcript 的 key，所以不需要另存一份 agent 侧 id。
// 对已存在的 session 再次调用会切换到 m（agent 只把 endpoint/key 留在内存里）。
func (c *Client) CreateSession(ctx context.Context, sandboxURL, sessionID string, m AgentModel) error {
	body, _ := json.Marshal(struct {
		ID string `json:"id"`
		AgentModel
	}{sessionID, m})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sandboxURL+"/session", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("agent create session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("agent create session status %d: %s", resp.StatusCode, b)
	}
	return nil
}

type messagePart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type sendMessageRequest struct {
	Parts []messagePart `json:"parts"`
}

func (c *Client) PromptAsync(ctx context.Context, sandboxURL, sessionID, text string) error {
	body, _ := json.Marshal(sendMessageRequest{
		Parts: []messagePart{{Type: "text", Text: text}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/session/%s/prompt_async", sandboxURL, sessionID),
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("agent prompt_async: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("agent prompt_async status %d: %s", resp.StatusCode, b)
	}
	return nil
}

func (c *Client) Abort(ctx context.Context, sandboxURL, sessionID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/session/%s/abort", sandboxURL, sessionID), nil,
	)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("agent abort: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("agent abort status %d: %s", resp.StatusCode, b)
	}
	return nil
}

// DeleteSession 中止并删除 agent 侧的 session transcript。
func (c *Client) DeleteSession(ctx context.Context, sandboxURL, sessionID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		fmt.Sprintf("%s/session/%s", sandboxURL, sessionID), nil,
	)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("agent delete session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusNotFound {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("agent delete session status %d: %s", resp.StatusCode, b)
	}
	return nil
}

// History 拉取 agent 的历史消息（已是 PlatformHistoryItem[] 格式）。
func (c *Client) History(ctx context.Context, sandboxURL, sessionID string) ([]PlatformHistoryItem, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/session/%s/message", sandboxURL, sessionID), nil,
	)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("agent history: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("agent history status %d: %s", resp.StatusCode, b)
	}
	var items []PlatformHistoryItem
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return nil, err
	}
	return items, nil
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
	return fmt.Errorf("timeout waiting for agent HTTP at %s", sandboxURL)
}

// sessionEvent 是 agent /event 总线上的一帧：平台事件外面包了一层 sessionId 用于路由。
type sessionEvent struct {
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}

// StreamEventsUntilIdle 连接 sandbox /event SSE，把属于 sessionID 的平台事件写入 w，
// 直到该 session 进入 idle。onEvent（可选）在每个事件转发前调用，调用方可借此落库。
func (c *Client) StreamEventsUntilIdle(ctx context.Context, sandboxURL, sessionID string, w io.Writer, onEvent func(*PlatformEvent)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sandboxURL+"/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev sessionEvent
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev); err != nil {
			continue
		}
		if ev.SessionID != sessionID {
			continue
		}
		platEv := &PlatformEvent{Type: ev.Type, Data: ev.Data}
		if onEvent != nil {
			onEvent(platEv)
		}
		b, _ := json.Marshal(platEv)
		fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		if ev.Type == EventSessionIdle {
			return nil
		}
	}
	return scanner.Err()
}
