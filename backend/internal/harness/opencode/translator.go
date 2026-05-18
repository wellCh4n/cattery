package opencode

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/wellch4n/cattery/internal/harness"
)

func init() {
	harness.Register("opencode", translate, translateHistory)
}

var (
	reTagPath    = regexp.MustCompile(`(?s)<path>(.*?)</path>`)
	reTagType    = regexp.MustCompile(`(?s)<type>(.*?)</type>`)
	reTagContent = regexp.MustCompile(`(?s)<content>(.*?)</content>`)
	reFileLine   = regexp.MustCompile(`^(\d+): (.*)`)
	reEndOfFile  = regexp.MustCompile(`\(End of file - total (\d+) lines\)`)
)

// parseToolOutput 按 tool 名解析 output，返回结构化数据；不认识的 tool 返回 nil。
func parseToolOutput(tool, output string) any {
	switch tool {
	case "read":
		if v := parseReadOutput(output); v != nil {
			return v
		}
	case "glob":
		if v := parseGlobOutput(output); v != nil {
			return v
		}
	}
	return nil
}

func parseGlobOutput(output string) *harness.ParsedGlob {
	var paths []string
	for _, line := range strings.Split(output, "\n") {
		s := strings.TrimSpace(line)
		if s == "" {
			continue
		}
		// 只收看起来像绝对路径的行；其它（如 "Found N files"）忽略
		if !strings.HasPrefix(s, "/") {
			continue
		}
		paths = append(paths, s)
	}
	if len(paths) == 0 {
		return nil
	}
	return &harness.ParsedGlob{Paths: paths}
}

func parseReadOutput(output string) *harness.ParsedFileRead {
	pathM := reTagPath.FindStringSubmatch(output)
	if pathM == nil {
		return nil
	}
	path := strings.TrimSpace(pathM[1])

	fileType := ""
	if typeM := reTagType.FindStringSubmatch(output); typeM != nil {
		fileType = strings.TrimSpace(typeM[1])
	}

	rawContent := ""
	if contentM := reTagContent.FindStringSubmatch(output); contentM != nil {
		rawContent = contentM[1]
	}

	var lines []harness.FileLine
	totalLines := 0
	for _, line := range strings.Split(rawContent, "\n") {
		if m := reFileLine.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			lines = append(lines, harness.FileLine{N: n, Text: m[2]})
			continue
		}
		if m := reEndOfFile.FindStringSubmatch(line); m != nil {
			totalLines, _ = strconv.Atoi(m[1])
		}
	}

	return &harness.ParsedFileRead{
		Path:       path,
		FileType:   fileType,
		Lines:      lines,
		TotalLines: totalLines,
	}
}

// opencode 原始事件结构（只取用到的字段）
type rawEvent struct {
	Type       string `json:"type"`
	Properties struct {
		SessionID string `json:"sessionID"`
		// session.updated 字段
		Info *struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"info"`
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
		Error *struct {
			Data *struct {
				Message string `json:"message"`
			} `json:"data"`
		} `json:"error"`
	} `json:"properties"`
}

// translate 把 opencode 原始事件翻译成平台统一格式。
// 返回 nil 表示该事件不需要转发。
// childSessions 用于收集 task 工具产生的子 session ID。
// state 在 SSE 连接生命周期内共享，这里用 "reasoningParts" 记录哪些 partID 属于 reasoning，
// 因为后续 message.part.delta 事件 field 固定为 "text"，没法从单条事件区分文本/思考。
func translate(raw string, primaryID string, childSessions map[string]bool, state map[string]any) (*harness.PlatformEvent, bool /* isIdle */) {
	var oc rawEvent
	if err := json.Unmarshal([]byte(raw), &oc); err != nil {
		return nil, false
	}

	reasoningParts, _ := state["reasoningParts"].(map[string]bool)
	if reasoningParts == nil {
		reasoningParts = map[string]bool{}
		state["reasoningParts"] = reasoningParts
	}

	sessID := oc.Properties.SessionID
	if sessID == "" && oc.Properties.Info != nil {
		sessID = oc.Properties.Info.ID
	}

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
	// 文本/思考增量
	case "message.part.delta":
		if oc.Properties.Field != "text" || oc.Properties.Delta == "" {
			return nil, false
		}
		if reasoningParts[oc.Properties.PartID] {
			ev := harness.NewMessageThinking(oc.Properties.PartID, oc.Properties.Delta)
			return &ev, false
		}
		ev := harness.NewMessageDelta(oc.Properties.PartID, oc.Properties.Delta)
		return &ev, false

	// part 状态更新：reasoning / tool
	case "message.part.updated":
		part := oc.Properties.Part
		if part == nil || part.State == nil {
			return nil, false
		}
		// reasoning part：记录 ID，让后续 delta 走 thinking 通道
		if part.Type == "reasoning" {
			reasoningParts[part.ID] = true
			return nil, false
		}
		if part.Type != "tool" {
			return nil, false
		}
		switch part.State.Status {
		case "running", "pending":
			ev := harness.NewToolStart(part.ID, part.Tool, string(part.State.Input))
			return &ev, false
		case "completed", "success":
			ev := harness.NewToolDone(part.ID, part.Tool, part.State.Output, parseToolOutput(part.Tool, part.State.Output))
			return &ev, false
		case "error":
			ev := harness.NewToolDone(part.ID, part.Tool, "error", nil)
			return &ev, false
		}

	case "session.idle":
		if sessID == primaryID {
			ev := harness.NewSessionIdle()
			return &ev, true
		}

	case "session.updated":
		if sessID == primaryID && oc.Properties.Info != nil {
			t := oc.Properties.Info.Title
			if t != "" && !strings.HasPrefix(t, "New session - ") && !strings.HasPrefix(t, "Child session - ") {
				ev := harness.NewSessionTitle(t)
				return &ev, false
			}
		}

	case "session.status":
		if sessID == primaryID && oc.Properties.Status != nil {
			switch oc.Properties.Status.Type {
			case "idle":
				ev := harness.NewSessionIdle()
				return &ev, true
			case "error":
				ev := harness.NewSessionError("session error")
				return &ev, false
			}
		}

	case "session.error":
		if sessID == primaryID || sessID == "" {
			msg := "unknown error"
			if oc.Properties.Error != nil && oc.Properties.Error.Data != nil && oc.Properties.Error.Data.Message != "" {
				msg = oc.Properties.Error.Data.Message
			}
			ev := harness.NewSessionError(msg)
			return &ev, false
		}
	}

	return nil, false
}
