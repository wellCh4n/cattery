package harness

import "encoding/json"

// claude-code harness 直接在 SSE 流中发送平台格式事件，包一层 sessionId 用于路由。
// 格式: {"sessionId":"xxx","type":"message.delta","data":{...}}
type claudeCodeRaw struct {
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}

func translateClaudeCode(raw string, primaryID string, _ map[string]bool) (*PlatformEvent, bool) {
	var ev claudeCodeRaw
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		return nil, false
	}
	if ev.SessionID != primaryID {
		return nil, false
	}
	plat := &PlatformEvent{Type: ev.Type, Data: ev.Data}
	return plat, ev.Type == EventSessionIdle
}

// TranslateClaudeCodeHistory 直接反序列化平台格式 — harness 已经存成 PlatformHistoryItem[]。
func TranslateClaudeCodeHistory(raw []byte) ([]PlatformHistoryItem, error) {
	var items []PlatformHistoryItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// TranslatorFor 按 harness 类型返回 SSE 翻译函数。
func TranslatorFor(harnessID string) TranslateFunc {
	if harnessID == "claude-code" {
		return translateClaudeCode
	}
	return translateOpencode
}

// HistoryTranslatorFor 按 harness 类型返回历史翻译函数。
func HistoryTranslatorFor(harnessID string) HistoryTranslateFunc {
	if harnessID == "claude-code" {
		return TranslateClaudeCodeHistory
	}
	return TranslateOpencodeHistory
}
