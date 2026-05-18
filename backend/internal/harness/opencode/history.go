package opencode

import (
	"encoding/json"

	"github.com/wellch4n/cattery/internal/harness"
)

// opencode /session/:id/message 返回结构（只取用到的字段）
type rawMessage struct {
	Info struct {
		ID   string `json:"id"`
		Role string `json:"role"` // "user" | "assistant"
	} `json:"info"`
	Parts []struct {
		ID    string `json:"id"`
		Type  string `json:"type"` // "text" | "tool" | ...
		Text  string `json:"text"`
		Tool  string `json:"tool"`
		State *struct {
			Status string          `json:"status"`
			Input  json.RawMessage `json:"input"`
			Output string          `json:"output"`
		} `json:"state"`
	} `json:"parts"`
}

// translateHistory 把 opencode 的历史消息列表翻译成平台统一格式。
func translateHistory(raw []byte) ([]harness.PlatformHistoryItem, error) {
	var msgs []rawMessage
	if err := json.Unmarshal(raw, &msgs); err != nil {
		return nil, err
	}

	items := make([]harness.PlatformHistoryItem, 0, len(msgs))
	for _, m := range msgs {
		item := harness.PlatformHistoryItem{
			MessageID: m.Info.ID,
			Role:      m.Info.Role,
		}
		for _, p := range m.Parts {
			switch p.Type {
			case "text":
				if p.Text == "" {
					continue
				}
				// 历史消息一次性给完整文本
				item.Events = append(item.Events, harness.NewMessageDelta(p.ID, p.Text))
			case "reasoning":
				if p.Text == "" {
					continue
				}
				item.Events = append(item.Events, harness.NewMessageThinking(p.ID, p.Text))
			case "tool":
				if p.State == nil {
					continue
				}
				switch p.State.Status {
				case "completed", "success":
					item.Events = append(item.Events,
						harness.NewToolStart(p.ID, p.Tool, string(p.State.Input)),
						harness.NewToolDone(p.ID, p.Tool, p.State.Output, parseToolOutput(p.Tool, p.State.Output)),
					)
				case "error":
					item.Events = append(item.Events,
						harness.NewToolStart(p.ID, p.Tool, string(p.State.Input)),
						harness.NewToolDone(p.ID, p.Tool, "error", nil),
					)
				}
			}
		}
		items = append(items, item)
	}
	return items, nil
}
