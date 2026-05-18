package claudecode

import (
	"encoding/json"

	"github.com/wellch4n/cattery/internal/harness"
)

func init() {
	harness.Register("claude-code", translate, translateHistory)
}

// claude-code harness 直接在 SSE 流中发送平台格式事件，包一层 sessionId 用于路由。
// 格式: {"sessionId":"xxx","type":"message.delta","data":{...}}
type rawEvent struct {
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}

func translate(raw string, primaryID string, _ map[string]bool, _ map[string]any) (*harness.PlatformEvent, bool) {
	var ev rawEvent
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		return nil, false
	}
	if ev.SessionID != primaryID {
		return nil, false
	}
	plat := &harness.PlatformEvent{Type: ev.Type, Data: ev.Data}
	return plat, ev.Type == harness.EventSessionIdle
}

// translateHistory 直接反序列化平台格式 — harness 已经存成 PlatformHistoryItem[]。
func translateHistory(raw []byte) ([]harness.PlatformHistoryItem, error) {
	var items []harness.PlatformHistoryItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	return items, nil
}
