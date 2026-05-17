package harness

import (
	"encoding/json"
)

// opencode 原始事件结构（只取用到的字段）
type opencodeEvent struct {
	Type       string `json:"type"`
	Properties struct {
		SessionID string `json:"sessionID"`
		// message.part.delta 字段
		PartID string `json:"partID"`
		Field  string `json:"field"`
		Delta  string `json:"delta"`
		// message.part.updated 字段
		Part *struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Tool  string `json:"tool"`
			State *struct {
				Status   string          `json:"status"`
				Input    json.RawMessage `json:"input"`
				Output   string          `json:"output"`
				Metadata *struct {
					SessionID string `json:"sessionId"`
				} `json:"metadata"`
			} `json:"state"`
		} `json:"part"`
		Status *struct {
			Type string `json:"type"`
		} `json:"status"`
	} `json:"properties"`
}

// translateOpencode 把 opencode 原始事件翻译成平台统一格式。
// 返回 nil 表示该事件不需要转发。
// childSessions 用于收集 task 工具产生的子 session ID。
func translateOpencode(raw string, primaryID string, childSessions map[string]bool) (*PlatformEvent, bool /* isIdle */) {
	var oc opencodeEvent
	if err := json.Unmarshal([]byte(raw), &oc); err != nil {
		return nil, false
	}

	sessID := oc.Properties.SessionID

	// 收集 task 工具的子 session
	if oc.Properties.Part != nil &&
		oc.Properties.Part.Tool == "task" &&
		oc.Properties.Part.State != nil &&
		oc.Properties.Part.State.Metadata != nil &&
		oc.Properties.Part.State.Metadata.SessionID != "" {
		childSessions[oc.Properties.Part.State.Metadata.SessionID] = true
	}

	// 过滤：只处理 primary session 和子 session 的事件
	if sessID != "" && sessID != primaryID && !childSessions[sessID] {
		return nil, false
	}

	switch oc.Type {
	// 文本增量
	case "message.part.delta":
		if oc.Properties.Field != "text" || oc.Properties.Delta == "" {
			return nil, false
		}
		ev := NewMessageDelta(oc.Properties.PartID, oc.Properties.Delta)
		return &ev, false

	// 工具调用：start / done
	case "message.part.updated":
		part := oc.Properties.Part
		if part == nil || part.Type != "tool" || part.State == nil {
			return nil, false
		}
		switch part.State.Status {
		case "running", "pending":
			ev := NewToolStart(part.ID, part.Tool, string(part.State.Input))
			return &ev, false
		case "completed", "success":
			ev := NewToolDone(part.ID, part.Tool, part.State.Output)
			return &ev, false
		case "error":
			ev := NewToolDone(part.ID, part.Tool, "error")
			return &ev, false
		}

	case "session.idle":
		if sessID == primaryID {
			ev := NewSessionIdle()
			return &ev, true
		}

	case "session.status":
		if sessID == primaryID &&
			oc.Properties.Status != nil &&
			oc.Properties.Status.Type == "idle" {
			ev := NewSessionIdle()
			return &ev, true
		}
	}

	return nil, false
}
