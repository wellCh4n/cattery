// Package harness 定义 agent sandbox（pi，见 harnesses/pi）对外的 HTTP 契约与平台事件格式。
// agent 直接发出平台格式事件，后端只按 sessionId 路由、透传给前端。
package harness

import "encoding/json"

// PlatformEvent 是平台统一的 SSE 事件格式，前端只处理这个。
type PlatformEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// 事件类型常量
const (
	EventMessageDelta    = "message.delta"         // AI 输出文本片段
	EventMessageThinking = "message.thinking"      // AI 思考过程片段（可选）
	EventThinkingDone    = "message.thinking.done" // 思考块结束: { partId, durationMs }
	EventToolStart       = "tool.start"            // 工具调用开始
	EventToolDone        = "tool.done"             // 工具调用结束
	EventSessionState    = "session.state"         // history snapshot: { busy: boolean }
	EventSessionIdle     = "session.idle"          // session 结束/空闲
	EventSessionError    = "session.error"         // 出错
	EventSessionTitle    = "session.title"         // session title 已生成/更新
)

type MessageDeltaData struct {
	PartID string `json:"partId"`
	Text   string `json:"text"` // 增量文本
}

type ToolStartData struct {
	ToolID string `json:"toolId"`
	Tool   string `json:"tool"`
	Input  string `json:"input,omitempty"`
}

type ToolDoneData struct {
	ToolID string `json:"toolId"`
	Tool   string `json:"tool"`
	Output string `json:"output,omitempty"`
	Parsed any    `json:"parsed,omitempty"` // official SDK tool details, forwarded without interpretation
}

type SessionErrorData struct {
	Message string `json:"message"`
}

type SessionTitleData struct {
	Title string `json:"title"`
}

// PlatformHistoryItem 是平台统一的历史消息条目，前端按它渲染。
type PlatformHistoryItem struct {
	MessageID string          `json:"messageId"`
	Role      string          `json:"role"`   // "user" | "assistant"
	Events    []PlatformEvent `json:"events"` // 这条消息包含的平台事件序列
}
