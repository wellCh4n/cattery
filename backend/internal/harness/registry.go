package harness

import "sync"

// 每个 harness 子包通过 init() 调用 Register 注册自己的翻译器。
// session_handler 通过 blank import 触发各子包注册。

type translators struct {
	stream  TranslateFunc
	history HistoryTranslateFunc
}

var (
	registryMu  sync.RWMutex
	registry    = map[string]translators{}
	defaultID   = "opencode"
)

// Register 注册一个 harness 的翻译器对（流式 + 历史）。
// 由各 harness 子包在 init() 中调用。
func Register(harnessID string, stream TranslateFunc, history HistoryTranslateFunc) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[harnessID] = translators{stream: stream, history: history}
}

// TranslatorFor 按 harness 类型返回 SSE 翻译函数。未知 harness 回退到默认。
func TranslatorFor(harnessID string) TranslateFunc {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if t, ok := registry[harnessID]; ok && t.stream != nil {
		return t.stream
	}
	return registry[defaultID].stream
}

// HistoryTranslatorFor 按 harness 类型返回历史翻译函数。未知 harness 回退到默认。
func HistoryTranslatorFor(harnessID string) HistoryTranslateFunc {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if t, ok := registry[harnessID]; ok && t.history != nil {
		return t.history
	}
	return registry[defaultID].history
}
