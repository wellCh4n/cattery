// Package harness 定义 agent sandbox（pi，见 harnesses/pi）对外的 HTTP 契约与平台事件格式。
// agent 直接发出平台格式事件，后端只按 sessionId 路由、透传给前端。
package harness

import "encoding/json"

// PlatformEvent 是平台统一的 SSE 事件格式，前端只处理这个。
// Seq 是 agent 给每个实时事件的递增序号（history 中的事件没有）。history 快照的
// session.state 带上它反映到的最后一个 seq，客户端据此只应用之后的事件。
type PlatformEvent struct {
	Seq  int64           `json:"seq,omitempty"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// 事件类型常量
const (
	EventMessageDelta    = "message.delta"         // AI 输出文本片段
	EventMessageUser     = "message.user"          // user 消息送达模型: { partId, text }，含 steer 插入的消息
	EventMessageThinking = "message.thinking"      // AI 思考过程片段（可选）
	EventThinkingDone    = "message.thinking.done" // 思考块结束: { partId, durationMs }
	EventToolStart       = "tool.start"            // 工具调用开始
	EventToolDone        = "tool.done"             // 工具调用结束
	EventSessionState    = "session.state"         // history snapshot: { busy: boolean, seq: number }
	EventSessionQueue    = "session.queue"         // 已 steer 但尚未送达模型的消息: { messages: string[] }
	EventSessionIdle     = "session.idle"          // session 结束/空闲
	EventSessionError    = "session.error"         // 出错
	EventSessionTitle    = "session.title"         // session title 已生成/更新
	EventSessionUsage    = "session.usage"         // context 占用与 token 累计，见 SessionUsageData
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

// SessionUsageData 在每轮结束、compaction 后和 history 快照中发出。
// ContextTokens 在 compaction 后、下一次回复前为 null；ReserveTokens 是自动 compaction 预留区。
type SessionUsageData struct {
	ContextTokens *int `json:"contextTokens"`
	ContextWindow int  `json:"contextWindow"`
	ReserveTokens int  `json:"reserveTokens"`
	Tokens        struct {
		Input      int `json:"input"`
		Output     int `json:"output"`
		CacheRead  int `json:"cacheRead"`
		CacheWrite int `json:"cacheWrite"`
	} `json:"tokens"`
	UserMessages int `json:"userMessages"`
	ToolCalls    int `json:"toolCalls"`
}

// PlatformHistoryItem 是平台统一的历史消息条目，前端按它渲染。
type PlatformHistoryItem struct {
	MessageID string `json:"messageId"`
	Role      string `json:"role"` // "user" | "assistant"
	// Timestamp is when the item's latest message was written (Unix ms); absent on the state item.
	Timestamp int64           `json:"timestamp,omitempty"`
	Events    []PlatformEvent `json:"events"` // 这条消息包含的平台事件序列
}
