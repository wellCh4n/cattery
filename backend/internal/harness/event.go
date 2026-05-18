package harness

import "encoding/json"

// PlatformEvent 是平台统一的 SSE 事件格式，前端只处理这个。
type PlatformEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// 事件类型常量
const (
	EventMessageDelta = "message.delta"  // AI 输出文本片段
	EventToolStart    = "tool.start"     // 工具调用开始
	EventToolDone     = "tool.done"      // 工具调用结束
	EventSessionIdle  = "session.idle"   // session 结束/空闲
	EventSessionError = "session.error"  // 出错
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
	Parsed any    `json:"parsed,omitempty"` // shape depends on Tool
}

// read tool
type ParsedFileRead struct {
	Path       string     `json:"path"`
	FileType   string     `json:"fileType"` // "file" | "directory"
	Lines      []FileLine `json:"lines"`
	TotalLines int        `json:"totalLines"`
}

type FileLine struct {
	N    int    `json:"n"`
	Text string `json:"text"`
}

// glob tool
type ParsedGlob struct {
	Paths []string `json:"paths"`
}

type SessionErrorData struct {
	Message string `json:"message"`
}

func NewMessageDelta(partID, text string) PlatformEvent {
	d, _ := json.Marshal(MessageDeltaData{PartID: partID, Text: text})
	return PlatformEvent{Type: EventMessageDelta, Data: d}
}

func NewToolStart(toolID, tool, input string) PlatformEvent {
	d, _ := json.Marshal(ToolStartData{ToolID: toolID, Tool: tool, Input: input})
	return PlatformEvent{Type: EventToolStart, Data: d}
}

func NewToolDone(toolID, tool, output string, parsed any) PlatformEvent {
	d, _ := json.Marshal(ToolDoneData{ToolID: toolID, Tool: tool, Output: output, Parsed: parsed})
	return PlatformEvent{Type: EventToolDone, Data: d}
}

func NewSessionIdle() PlatformEvent {
	return PlatformEvent{Type: EventSessionIdle, Data: json.RawMessage("{}")}
}

func NewSessionError(msg string) PlatformEvent {
	d, _ := json.Marshal(SessionErrorData{Message: msg})
	return PlatformEvent{Type: EventSessionError, Data: d}
}
