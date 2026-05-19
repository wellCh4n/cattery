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
 *
 * Config via env:
 *   PORT      — listen port (default 4096; matches existing HTTP harnesses)
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
const PORT     = Number(process.env.PORT ?? 4096)
const TUI_CMD  = process.env.TUI_CMD ?? ''
const WORK_DIR = process.env.WORK_DIR ?? '/work'

if (!TUI_CMD) {
  console.error('[startup] TUI_CMD is required (e.g. "codex" or "hermes")')
  process.exit(1)
}

console.log(`[startup] TUI_CMD : ${TUI_CMD}`)
console.log(`[startup] WORK_DIR: ${WORK_DIR}`)
console.log(`[startup] PORT    : ${PORT}`)

// ── Codex auth: pre-seed ~/.codex/config.toml ────────────────────────────────
//
// Codex CLI shows an interactive sign-in picker on first launch unless it
// finds a custom provider with `env_key` set. We render config.toml from
// MODEL + OPENAI_BASE_URL so the TUI starts in API-key mode and goes
// straight to the prompt. Hermes doesn't need this — it's gated by its own
// SPAWN_CMD logic upstream.
if (TUI_CMD === 'codex') {
  seedCodexConfig()
}

function seedCodexConfig(): void {
  const home = process.env.HOME ?? ''
  if (!home) {
    console.warn('[startup] HOME unset, skipping codex config seed')
    return
  }
  const dir  = path.join(home, '.codex')
  const file = path.join(dir, 'config.toml')

  // Point codex directly at the upstream gateway. Codex v0.131+ only
  // speaks the Responses API (/v1/responses); the gateway must support it.
  const baseURL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '') + '/v1'
  const model   = process.env.MODEL ?? 'gpt-4o'

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

function createSession(id: string): void {
  // -d     : start detached (no client attached yet)
  // -s     : session name
  // -c     : start directory
  // -x/-y  : initial dimensions. Detached tmux sessions default to 80x24,
  //          and TUIs that sample terminal size at startup may pick a
  //          compact layout that never recovers once the browser attaches
  //          at a larger size. Pre-sizing gives the TUI room to render its
  //          full layout from the first frame.
  // Final positional arg is the command tmux will run in the initial window.
  const r = tmux(['new-session', '-d', '-s', id, '-x', '120', '-y', '32', '-c', WORK_DIR, TUI_CMD])
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

app.post('/session', (_req, res) => {
  const id = randomUUID()
  try {
    createSession(id)
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

function isResizeFrame(v: unknown): v is ResizeFrame {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o.type === 'resize' && typeof o.cols === 'number' && typeof o.rows === 'number'
}

wss.on('connection', (ws: WebSocket, sessionId: string) => {
  // -d detaches any other clients first, so we don't have multiple writers
  // fighting over the same PTY. Each browser connection becomes the sole
  // attached client for the duration of the WS.
  const term = pty.spawn('tmux', ['attach-session', '-d', '-t', sessionId], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: WORK_DIR,
    env: process.env as Record<string, string>,
  })

  console.log(`[ws] attached to ${sessionId} (pid=${term.pid})`)

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data)
  })

  term.onExit(({ exitCode }) => {
    console.log(`[ws] term exited code=${exitCode} session=${sessionId}`)
    if (ws.readyState === ws.OPEN) ws.close(1000, 'tmux client exited')
  })

  ws.on('message', (raw, isBinary) => {
    // Text frames may be control JSON; binary frames are keystrokes.
    if (!isBinary) {
      const text = raw.toString('utf-8')
      try {
        const parsed = JSON.parse(text) as unknown
        if (isResizeFrame(parsed)) {
          term.resize(parsed.cols, parsed.rows)
          return
        }
      } catch {
        // not JSON — fall through and treat as input bytes
      }
      term.write(text)
      return
    }
    term.write(raw.toString('binary'))
  })

  ws.on('close', () => {
    console.log(`[ws] client closed, killing attach pid=${term.pid}`)
    try { term.kill() } catch { /* already gone */ }
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
