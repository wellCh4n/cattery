/**
 * Cattery codex shim — tmux's pane runs *this* instead of codex directly so we
 * can fake an OSC 10/11 reply on the way through.
 *
 * Codex's startup probe writes `\x1b]10;?\x1b\\` + `\x1b]11;?\x1b\\` to query
 * the outer terminal's default fg/bg, then reads stdin for ~100ms. If neither
 * comes back (always the case in detached tmux), `default_bg()` is None and
 * style.rs::user_message_style falls back to no background, so the chat-input
 * block renders unstyled.
 *
 * Pre-injecting via `tmux send-keys` doesn't work: codex calls
 * `tcflush(STDIN, TCIFLUSH)` right after entering raw mode (tui.rs), so any
 * pre-existing bytes are discarded; injecting earlier hits the cooked-mode
 * line discipline and echoes `^[]10;…` to the user instead.
 *
 * This wrapper sits in-PTY, watches codex's stdout for the query bytes, and
 * writes the synthetic reply straight back into codex's stdin — the same
 * choreography a real terminal performs. The reply is timing-safe: it lands
 * inside codex's read window because it's *triggered* by the query.
 */

import * as pty from 'node-pty'

const cols = process.stdout.columns ?? 120
const rows = process.stdout.rows ?? 32

const codex = pty.spawn('codex', [], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
})

// Colors track the cattery web theme palette in
// web/components/terminal-view.tsx::themeFor. CATTERY_THEME ("light" | "dark")
// is set by the backend at session-creation time via `tmux new-session -e`
// (see harnesses/codex/src/server.ts), so codex picks the matching ratatui
// palette on its first OSC 10/11 probe. The probe only fires once; switching
// the browser theme after the session is created won't restyle codex.
const OSC_10_QUERY = '\x1b]10;?'
const OSC_11_QUERY = '\x1b]11;?'
const isLight = (process.env.CATTERY_THEME ?? 'dark') === 'light'
const OSC_10_REPLY = isLight
  ? '\x1b]10;rgb:1f/29/37\x1b\\' // light fg = slate-800
  : '\x1b]10;rgb:e5/e7/eb\x1b\\' // dark  fg = gray-200
const OSC_11_REPLY = isLight
  ? '\x1b]11;rgb:ff/ff/ff\x1b\\' // light bg = white
  : '\x1b]11;rgb:0b/0d/12\x1b\\' // dark  bg = near-black

// Carry a tiny tail across chunks so a query split across two onData callbacks
// still matches. The longest query is 6 bytes; 64 is comfortable headroom.
const TAIL_KEEP = 64
let tail = ''

codex.onData((data) => {
  process.stdout.write(data)
  tail = (tail + data).slice(-TAIL_KEEP)
  if (tail.includes(OSC_10_QUERY)) {
    codex.write(OSC_10_REPLY)
    tail = tail.replace(OSC_10_QUERY, '')
  }
  if (tail.includes(OSC_11_QUERY)) {
    codex.write(OSC_11_REPLY)
    tail = tail.replace(OSC_11_QUERY, '')
  }
})

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  // Decode as UTF-8, not 'binary' (latin1). The bytes coming in are already
  // UTF-8 from the browser → tui-bridge → tmux path; latin1-decoding then
  // letting node-pty re-encode doubles every non-ASCII byte (typing "中"
  // arrives at codex as "Ã¸\xad" mojibake).
  codex.write(chunk.toString('utf-8'))
})

process.stdout.on('resize', () => {
  try {
    codex.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows)
  } catch { /* codex exited */ }
})

const FORWARD_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
for (const sig of FORWARD_SIGNALS) {
  process.on(sig, () => {
    try { codex.kill(sig) } catch { /* already gone */ }
  })
}

codex.onExit(({ exitCode }) => {
  process.exit(exitCode ?? 0)
})
