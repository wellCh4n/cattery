// Package hermes 注册 hermes 这个 TUI 类 harness。
// session 通过 WebSocket + PTY 直传 tmux 字节流，没有平台事件翻译。
package hermes

import "github.com/wellch4n/cattery/internal/harness"

func init() {
	harness.RegisterTerminal("hermes")
}
