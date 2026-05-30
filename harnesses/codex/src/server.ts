/**
 * Cattery TUI bridge — wraps a CLI TUI (codex, hermes, …) behind a minimal
 * HTTP + WebSocket contract that the cattery backend can talk to:
 *
 *   POST   /session               → { id } — creates `tmux new-session -d -s <uuid> $TUI_CMD`
 *   GET    /session               → string[] — list of live tmux session ids
 *   GET    /session/:id           → { id } | 404
 *   DELETE /session/:id           → 204 — `tmux kill-session -t :id`
 *   GET    /healthz               → 200
 *
 *   WS     /session/:id/term      → bi-directional PTY bridge to `tmux attach -t :id -d`
 *                                   - server → client: raw PTY bytes (binary frames)
 *                                   - client → server: raw bytes (binary frames) or JSON
 *                                       { "type": "resize", "cols": n, "rows": n }
 *
 * The tmux server is started lazily by the first `tmux new-session` and lives
 * for the lifetime of the container. WS close only kills the attach client
 * process; the TUI inside the tmux session and its in-memory state survive,
 * so re-attaching restores the same TUI screen — this is how "resume" works.
 * If the TUI itself exits (e.g. Ctrl+C to quit codex/hermes), a supervisor
 * loop relaunches it in place (see superviseCmd) so the session stays
 * reconnectable instead of being torn down.
 *
 * Config via env:
 *   PORT      — listen port (default 1114; matches existing HTTP harnesses)
 *   TUI_CMD   — the command to spawn inside tmux (e.g. `codex`, `hermes`)
 *   WORK_DIR  — cwd for the tmux session (default /work)
 */

import express from 'express'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as pty from 'node-pty'
import { WebSocketServer, WebSocket } from 'ws'
const PORT     = Number(process.env.PORT ?? 1114)
const TUI_CMD  = process.env.TUI_CMD ?? ''
const WORK_DIR = process.env.WORK_DIR ?? '/work'

if (!TUI_CMD) {
  console.error('[startup] TUI_CMD is required (e.g. "codex" or "hermes")')
  process.exit(1)
}

console.log(`[startup] TUI_CMD : ${TUI_CMD}`)
console.log(`[startup] WORK_DIR: ${WORK_DIR}`)
console.log(`[startup] PORT    : ${PORT}`)

// ── Codex bootstrap ──────────────────────────────────────────────────────────
//
// Two things to set up before tmux launches codex:
//   1) codex-relay sidecar (translates Responses ↔ Chat Completions). Only
//      needed for claude-* models — NewAPI natively supports /v1/responses
//      for OpenAI models but not for Anthropic, so GPT sessions skip the
//      relay and talk straight to the upstream gateway.
//   2) ~/.codex/config.toml seeded with a custom provider, so codex skips
//      its interactive sign-in picker on first launch. The provider's
//      base_url points at the relay or the gateway depending on (1).
// Hermes doesn't need either — it's gated by its own SPAWN_CMD logic upstream.
const CODEX_RELAY_PORT = Number(process.env.CODEX_RELAY_PORT ?? 4444)
const CODEX_MODEL      = process.env.MODEL ?? 'gpt-4o'
const CODEX_NEEDS_RELAY = CODEX_MODEL.startsWith('claude')

if (TUI_CMD === 'codex') {
  if (CODEX_NEEDS_RELAY) startCodexRelay()
  seedCodexConfig()
}

// ── codex-relay sidecar ──────────────────────────────────────────────────────
//
// codex >=0.131 only speaks the OpenAI Responses API (POST /v1/responses).
// Our upstream gateway (NewAPI) translates Chat Completions ↔ Anthropic
// Messages, but Responses ↔ anything is still 🚧. codex-relay bridges the
// gap in-container: codex → 127.0.0.1:4444 (Responses) → upstream (Chat
// Completions) → NewAPI does its claude/openai routing per model.
//
// Stays alive for the container's lifetime; if it dies, codex requests fail
// loudly with connection refused — we surface that via stderr passthrough.
function startCodexRelay(): void {
  const upstream = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '')
  const apiKey   = process.env.OPENAI_API_KEY ?? ''

  const relay = spawn('codex-relay', [], {
    env: {
      ...process.env,
      CODEX_RELAY_UPSTREAM: upstream,
      CODEX_RELAY_API_KEY:  apiKey,
      CODEX_RELAY_PORT:     String(CODEX_RELAY_PORT),
      RUST_LOG:             process.env.RUST_LOG ?? 'codex_relay=info',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  relay.on('exit', (code, signal) => {
    console.error(`[codex-relay] exited code=${code} signal=${signal} — subsequent codex requests will fail`)
  })

  // Forward terminate signals so the relay doesn't outlive the bridge.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      try { relay.kill(sig) } catch { /* already gone */ }
    })
  }

  console.log(`[startup] codex-relay → ${upstream} (listen :${CODEX_RELAY_PORT})`)
}

function seedCodexConfig(): void {
  const home = process.env.HOME ?? ''
  if (!home) {
    console.warn('[startup] HOME unset, skipping codex config seed')
    return
  }
  const dir  = path.join(home, '.codex')
  const file = path.join(dir, 'config.toml')

  // claude-* models route through the local relay; OpenAI models go straight
  // to the upstream NewAPI gateway, which already speaks Responses natively.
  const baseURL = CODEX_NEEDS_RELAY
    ? `http://127.0.0.1:${CODEX_RELAY_PORT}/v1`
    : (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '')
  const model   = CODEX_MODEL

  const toml = [
    `model = ${JSON.stringify(model)}`,
    `model_provider = "cattery"`,
    ``,
    `[model_providers.cattery]`,
    `name = "Cattery gateway"`,
    `base_url = ${JSON.stringify(baseURL)}`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = "responses"`,
    ``,
    // Pre-trust WORK_DIR so codex skips the "Do you trust the contents of
    // this directory?" prompt on first launch. The table key MUST be the
    // absolute path; the wildcard form ["projects.*"] is not honored.
    `[projects.${JSON.stringify(WORK_DIR)}]`,
    `trust_level = "trusted"`,
    ``,
  ].join('\n')

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, toml)
    console.log(`[startup] wrote ${file} (model=${model}, base_url=${baseURL})`)
  } catch (err) {
    console.error('[startup] failed to seed codex config:', err instanceof Error ? err.message : err)
  }
}

// ── tmux helpers ─────────────────────────────────────────────────────────────

function tmux(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function sessionExists(id: string): boolean {
  return tmux(['has-session', '-t', id]).code === 0
}

function listSessions(): string[] {
  const r = tmux(['list-sessions', '-F', '#{session_name}'])
  if (r.code !== 0) return []
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

// Shell-single-quote a token so it can be embedded safely in an `sh -c` script.
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Wrap the TUI launch in a supervisor loop so the tmux session outlives the TUI
// process. Pressing Ctrl+C inside codex/hermes (double-tap to quit) terminates
// the TUI; with a bare `tmux new-session <tui>` that exits the pane's only
// process and tmux tears the whole session down, so every later WS reconnect
// 404s on `has-session` — the "can't reconnect after Ctrl+C" bug. The loop
// relaunches the TUI in place instead: an attached client sees a fresh TUI at
// once and reconnects keep working. (A `pane-died` hook would be tidier but does
// not fire reliably in tmux 3.3a, so we supervise from the shell.)
//
//   trap '' INT — the supervisor shell ignores SIGINT. While the TUI runs it
//     holds the pty in raw mode (ISIG off), so Ctrl+C reaches the TUI as a key,
//     not a signal, and its own interrupt/quit handling is unchanged. The trap
//     only matters in the brief cooked-mode gap between TUI exit and relaunch,
//     where a stray Ctrl+C would otherwise SIGINT the whole foreground group and
//     kill the supervisor too, reopening the bug.
//   sleep 0.5 — floor on relaunch rate so a TUI that exits instantly (e.g. bad
//     config) flickers instead of pinning a CPU.
function superviseCmd(inner: string[]): string[] {
  const innerCmd = inner.map(sq).join(' ')
  const script =
    `trap '' INT; while true; do ${innerCmd}; ` +
    `printf '\\r\\n[cattery] session ended, restarting...\\r\\n'; sleep 0.5; done`
  return ['sh', '-c', script]
}

function createSession(id: string, theme: 'light' | 'dark'): void {
  // -d     : start detached (no client attached yet)
  // -s     : session name
  // -c     : start directory
  // -x/-y  : initial dimensions. Detached tmux sessions default to 80x24,
  //          and TUIs that sample terminal size at startup may pick a
  //          compact layout that never recovers once the browser attaches
  //          at a larger size. Pre-sizing gives the TUI room to render its
  //          full layout from the first frame.
  // -e     : env vars for the session. CATTERY_THEME is read by codex-wrapper
  //          to pick the OSC 10/11 reply that drives codex's light/dark
  //          ratatui palette.
  // Final positional arg is the command tmux will run in the initial window.
  // Codex (Ratatui-based) sends OSC 10 + OSC 11 at startup to probe the outer
  // terminal's fg/bg and only fills the chat-input block when both responses
  // come back — see codex-rs/tui/src/style.rs::user_message_style. Inside a
  // detached tmux there's no outer terminal to answer; codex flushes stdin
  // post-raw-mode (tui.rs::flush_terminal_input_buffer), so pre-injected
  // replies are discarded. Run codex under a small node-pty wrapper that
  // watches its output for the OSC query and writes the reply straight back
  // into codex's stdin — same effect a real terminal would have. hermes and
  // other harnesses don't run this probe; let them spawn directly.
  const cmd = TUI_CMD === 'codex'
    ? ['tsx', path.join(__dirname, 'codex-wrapper.ts')]
    : [TUI_CMD]
  const r = tmux([
    'new-session', '-d', '-s', id,
    '-x', '120', '-y', '32',
    '-c', WORK_DIR,
    '-e', `CATTERY_THEME=${theme}`,
    ...superviseCmd(cmd),
  ])
  if (r.code !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`)
  }
}

function killSession(id: string): void {
  tmux(['kill-session', '-t', id])
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok')
})

app.get('/session', (_req, res) => {
  res.json(listSessions())
})

app.post('/session', (req, res) => {
  const id = randomUUID()
  const rawTheme = (req.body && (req.body as { theme?: unknown }).theme)
  const theme: 'light' | 'dark' = rawTheme === 'light' ? 'light' : 'dark'
  try {
    createSession(id, theme)
  } catch (err) {
    console.error('[POST /session] failed:', err instanceof Error ? err.message : err)
    return void res.status(500).json({ error: 'failed to create tmux session' })
  }
  res.json({ id })
})

app.get('/session/:id', (req, res) => {
  if (!sessionExists(req.params.id)) return void res.status(404).json({ error: 'not found' })
  res.json({ id: req.params.id })
})

app.delete('/session/:id', (req, res) => {
  killSession(req.params.id)
  res.status(204).end()
})

// ── WS: PTY bridge ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true })

interface ResizeFrame {
  type: 'resize'
  cols: number
  rows: number
}

interface ThemeFrame {
  type: 'theme'
  theme: 'light' | 'dark'
}

function isResizeFrame(v: unknown): v is ResizeFrame {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o.type === 'resize' && typeof o.cols === 'number' && typeof o.rows === 'number'
}

function isThemeFrame(v: unknown): v is ThemeFrame {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o.type === 'theme' && (o.theme === 'light' || o.theme === 'dark')
}

function normalizeResizeFrame(frame: ResizeFrame): ResizeFrame | null {
  const cols = Math.floor(frame.cols)
  const rows = Math.floor(frame.rows)
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return null
  return { type: 'resize', cols, rows }
}

const CODEX_LIGHT_INPUT_BG_SEMI = '48;2;238;238;238'
const CODEX_DARK_INPUT_BG_SEMI  = '48;2;38;38;38'
const CODEX_LIGHT_INPUT_BG_COLON = '48:2::238:238:238'
const CODEX_DARK_INPUT_BG_COLON  = '48:2::38:38:38'

function rewriteCodexThemeColors(data: string, theme: 'light' | 'dark'): string {
  // Codex paints its chat-input block with truecolor SGR derived from the
  // startup OSC 10/11 probe. Browser theme changes do not make the running
  // TUI recompute that palette, so rewrite the known input-block background
  // colors as bytes leave tmux for this browser connection.
  const target = theme === 'light' ? CODEX_LIGHT_INPUT_BG_SEMI : CODEX_DARK_INPUT_BG_SEMI
  const targetParts = target.split(';')
  const rewritten = data.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
    const parts = params.split(';')
    const next: string[] = []
    let changed = false

    for (let i = 0; i < parts.length; i++) {
      const code = Number(parts[i])
      if (theme === 'light' && (code === 40 || code === 100)) {
        next.push(...targetParts)
        changed = true
        continue
      }
      if (theme === 'dark' && (code === 47 || code === 107)) {
        next.push(...targetParts)
        changed = true
        continue
      }
      if (code === 48 && parts[i + 1] === '5') {
        const color = Number(parts[i + 2])
        const shouldRewrite = theme === 'light'
          ? color >= 232 && color <= 238
          : color >= 250 && color <= 255
        if (shouldRewrite) {
          next.push(...targetParts)
          changed = true
          i += 2
          continue
        }
      }
      if (code === 48 && parts[i + 1] === '2') {
        const r = Number(parts[i + 2])
        const g = Number(parts[i + 3])
        const b = Number(parts[i + 4])
        const shouldRewrite = theme === 'light'
          ? isDarkNeutral(r, g, b)
          : isLightNeutral(r, g, b)
        if (shouldRewrite) {
          next.push(...targetParts)
          changed = true
          i += 4
          continue
        }
      }
      next.push(parts[i])
    }

    return changed ? `\x1b[${next.join(';')}m` : seq
  })

  return theme === 'light'
    ? rewritten.replace(/48:2::(?:35:35:35|38:38:38|40:40:40)/g, CODEX_LIGHT_INPUT_BG_COLON)
    : rewritten.replace(/48:2::(?:229:229:229|235:235:235|238:238:238)/g, CODEX_DARK_INPUT_BG_COLON)
}

function isDarkNeutral(r: number, g: number, b: number): boolean {
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
    && Math.max(r, g, b) <= 70
    && Math.max(r, g, b) - Math.min(r, g, b) <= 12
}

function isLightNeutral(r: number, g: number, b: number): boolean {
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
    && Math.min(r, g, b) >= 220
    && Math.max(r, g, b) - Math.min(r, g, b) <= 20
}

wss.on('connection', (ws: WebSocket, sessionId: string) => {
  // Defer `tmux attach-session` until the browser sends its first resize.
  //
  // tmux resizes the session to match its newest attached client. If we
  // attach immediately at a hardcoded size, tmux first resizes the session
  // to that size, then resizes again when the browser's resize JSON arrives
  // — two SIGWINCHes back-to-back. TUIs that redraw incrementally (e.g.
  // hermes / prompt_toolkit) end up painting their prompt twice on top of
  // tmux's screen replay, leaving ghost `❯` glyphs. Attaching at the right
  // size from the first frame avoids the resize storm entirely.
  let term: pty.IPty | null = null
  // Buffer keystrokes that arrive before attach completes (the < ~100ms
  // window between ws.open and the resize frame). Flushed in startAttach.
  const pendingInput: string[] = []
  let currentSize: { cols: number; rows: number } | null = null
  let currentTheme: 'light' | 'dark' = 'dark'

  const startAttach = (cols: number, rows: number): void => {
    if (term) return
    currentSize = { cols, rows }
    // -d detaches any other clients first, so we don't have multiple writers
    // fighting over the same PTY. Each browser connection becomes the sole
    // attached client for the duration of the WS.
    term = pty.spawn('tmux', ['attach-session', '-d', '-t', sessionId], {
      name: 'tmux-256color',
      cols,
      rows,
      cwd: WORK_DIR,
      env: {
        ...process.env,
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    })
    console.log(`[ws] attached to ${sessionId} (pid=${term.pid}, ${cols}x${rows})`)

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(rewriteCodexThemeColors(data, currentTheme))
    })

    term.onExit(({ exitCode }) => {
      console.log(`[ws] term exited code=${exitCode} session=${sessionId}`)
      if (ws.readyState === ws.OPEN) ws.close(1000, 'tmux client exited')
    })

    for (const chunk of pendingInput) term.write(chunk)
    pendingInput.length = 0
  }

  // Safety net: if no resize arrives, fall back to the old defaults so the
  // session isn't stuck waiting. Browser sends resize on ws.open, so this
  // should never fire in practice.
  const fallbackTimer = setTimeout(() => startAttach(120, 32), 1000)

  ws.on('message', (raw, isBinary) => {
    // Text frames may be control JSON; binary frames are keystrokes.
    if (!isBinary) {
      const text = raw.toString('utf-8')
      try {
        const parsed = JSON.parse(text) as unknown
        if (isResizeFrame(parsed)) {
          const nextSize = normalizeResizeFrame(parsed)
          if (!nextSize) return
          clearTimeout(fallbackTimer)
          if (!term) startAttach(nextSize.cols, nextSize.rows)
          else if (!currentSize || currentSize.cols !== nextSize.cols || currentSize.rows !== nextSize.rows) {
            currentSize = { cols: nextSize.cols, rows: nextSize.rows }
            term.resize(nextSize.cols, nextSize.rows)
          }
          return
        }
        if (isThemeFrame(parsed)) {
          currentTheme = parsed.theme
          return
        }
      } catch {
        // not JSON — fall through and treat as input bytes
      }
      if (term) term.write(text)
      else pendingInput.push(text)
      return
    }
    // Browser sends keystrokes as UTF-8 bytes via TextEncoder. Decoding with
    // 'binary' (latin1) and then letting node-pty re-encode as UTF-8 doubles
    // every non-ASCII byte — typing "中" (E4 B8 AD) lands at the PTY as
    // "Ã¸\xad" mojibake. Decode as UTF-8 so the bytes pass through unchanged.
    const text = raw.toString('utf-8')
    if (term) term.write(text)
    else pendingInput.push(text)
  })

  ws.on('close', () => {
    clearTimeout(fallbackTimer)
    if (term) {
      console.log(`[ws] client closed, killing attach pid=${term.pid}`)
      try { term.kill() } catch { /* already gone */ }
    }
  })

  ws.on('error', (err) => {
    console.error(`[ws] error session=${sessionId}:`, err.message)
  })
})

// ── HTTP server + upgrade ───────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[tui-bridge] listening on :${PORT}`)
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost')
  const match = url.pathname.match(/^\/session\/([^/]+)\/term$/)
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const sessionId = match[1]
  if (!sessionExists(sessionId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, sessionId)
  })
})

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`[shutdown] received ${signal}, killing tmux server`)
  // kill-server takes down all sessions; the container is going away anyway
  spawn('tmux', ['kill-server'], { stdio: 'ignore' })
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
