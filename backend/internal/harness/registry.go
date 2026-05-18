package harness

import "sync"

// 每个 harness 子包通过 init() 调用 Register 注册自己。
// session_handler 通过 blank import 触发各子包注册。

// Kind 决定 session 的传输形态：
//   - KindHTTP     —— harness 实现 POST /session + SSE /event 契约，事件经 translator 翻译成平台格式
//   - KindTerminal —— harness 包装一个 TUI（codex/hermes 等），session 通过 WebSocket + PTY 直传字节
type Kind string

const (
	KindHTTP     Kind = "http"
	KindTerminal Kind = "terminal"
)

type entry struct {
	kind    Kind
	stream  TranslateFunc
	history HistoryTranslateFunc
}

var (
	registryMu sync.RWMutex
	registry   = map[string]entry{}
	defaultID  = "opencode"
)

// Register 注册一个 HTTP 类 harness 的翻译器对（流式 + 历史）。
func Register(harnessID string, stream TranslateFunc, history HistoryTranslateFunc) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[harnessID] = entry{kind: KindHTTP, stream: stream, history: history}
}

// RegisterTerminal 注册一个 TUI 类 harness。终端类没有平台事件翻译，前端直接消费 PTY 字节流。
func RegisterTerminal(harnessID string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[harnessID] = entry{kind: KindTerminal}
}

// KindFor 返回 harness 的传输形态。未注册的 harness 视为 HTTP 兼容（向前兼容）。
func KindFor(harnessID string) Kind {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if e, ok := registry[harnessID]; ok {
		return e.kind
	}
	return KindHTTP
}

// TranslatorFor 按 harness 类型返回 SSE 翻译函数。未知/终端类回退到默认 HTTP harness 的翻译器。
func TranslatorFor(harnessID string) TranslateFunc {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if e, ok := registry[harnessID]; ok && e.stream != nil {
		return e.stream
	}
	return registry[defaultID].stream
}

// HistoryTranslatorFor 按 harness 类型返回历史翻译函数。未知/终端类回退到默认。
func HistoryTranslatorFor(harnessID string) HistoryTranslateFunc {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if e, ok := registry[harnessID]; ok && e.history != nil {
		return e.history
	}
	return registry[defaultID].history
}
