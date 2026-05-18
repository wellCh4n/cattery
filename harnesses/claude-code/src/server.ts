import express from 'express'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-code'
import type { SDKMessage } from '@anthropic-ai/claude-code'

const app = express()
app.use(express.json())

const PORT    = Number(process.env.PORT    ?? 4096)
const MODEL   = process.env.MODEL         ?? 'claude-sonnet-4-6'
const PROMPT  = process.env.AGENT_PROMPT  ?? ''
const WORKDIR = process.env.WORK_DIR      ?? '/work'

// ── Platform event types (mirror backend harness/event.go) ──────────────────

type PlatformEventType =
  | 'message.delta'
  | 'tool.start'
  | 'tool.done'
  | 'session.idle'
  | 'session.error'
  | 'session.title'

interface PlatformEvent {
  type: PlatformEventType
  data: unknown
}

interface HistoryItem {
  messageId: string
  role: 'user' | 'assistant'
  events: PlatformEvent[]
}

// ── Session state ────────────────────────────────────────────────────────────

interface HarnessSession {
  id: string
  claudeSessionId: string | null   // from SDK system.init; used for multi-turn resume
  history: HistoryItem[]
  abort: AbortController | null
}

const sessions  = new Map<string, HarnessSession>()

// SSE clients: all GET /event connections
const sseClients = new Set<(payload: string) => void>()

function broadcast(sessionId: string, ev: PlatformEvent): void {
  const payload = JSON.stringify({ sessionId, type: ev.type, data: ev.data })
  for (const send of sseClients) {
    try { send(payload) } catch { /* ignore closed connections */ }
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

// Health check — WaitHTTPReady in Go calls GET /session expecting 200
app.get('/session', (_req, res) => {
  res.json([...sessions.keys()])
})

app.post('/session', (_req, res) => {
  const id = randomUUID()
  sessions.set(id, { id, claudeSessionId: null, history: [], abort: null })
  res.json({ id })
})

app.get('/session/:id', (req, res) => {
  const sess = sessions.get(req.params.id)
  if (!sess) return void res.status(404).json({ error: 'not found' })
  res.json({ id: sess.id })
})

// History returns PlatformHistoryItem[] directly — backend uses TranslateClaudeCodeHistory
app.get('/session/:id/message', (req, res) => {
  const sess = sessions.get(req.params.id)
  res.json(sess?.history ?? [])
})

// Fire-and-forget: start query, return 204 immediately
app.post('/session/:id/prompt_async', (req, res) => {
  const sess = sessions.get(req.params.id)
  if (!sess) return void res.status(404).end()

  const parts: Array<{ type: string; text: string }> = req.body?.parts ?? []
  const text = parts.find((p) => p.type === 'text')?.text?.trim() ?? ''
  if (!text) return void res.status(400).end()

  res.status(204).end()
  void runPrompt(sess, text)
})

app.post('/session/:id/abort', (req, res) => {
  sessions.get(req.params.id)?.abort?.abort('user aborted')
  res.status(204).end()
})

// SSE stream — backend connects here, filters events by sessionId field
app.get('/event', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (payload: string) => res.write(`data: ${payload}\n\n`)
  sseClients.add(send)
  req.on('close', () => sseClients.delete(send))
})

// ── Query runner ─────────────────────────────────────────────────────────────

async function runPrompt(sess: HarnessSession, prompt: string): Promise<void> {
  // Abort any in-flight query for this session
  if (sess.abort) sess.abort.abort('superseded')

  const abort = new AbortController()
  sess.abort = abort

  const isFirst = sess.history.length === 0

  // Record user turn in history
  const userMsgId = randomUUID()
  sess.history.push({
    messageId: userMsgId,
    role: 'user',
    events: [{ type: 'message.delta', data: { partId: userMsgId, text: prompt } }],
  })

  // Derive session title from first prompt
  if (isFirst) {
    const title = prompt.length > 60 ? `${prompt.slice(0, 57).trimEnd()}…` : prompt
    broadcast(sess.id, { type: 'session.title', data: { title } })
  }

  const assistantItem: HistoryItem = { messageId: randomUUID(), role: 'assistant', events: [] }
  // Map tool_use.id → tool name so tool.done can include the name
  const pendingToolNames = new Map<string, string>()

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: Record<string, any> = {
      model: MODEL,
      maxTurns: 30,
      permissionMode: 'bypassPermissions',
      cwd: WORKDIR,
    }
    if (PROMPT)              opts['appendSystemPrompt'] = PROMPT
    if (sess.claudeSessionId) opts['resume']            = sess.claudeSessionId

    for await (const msg of query({ prompt, options: opts, abortController: abort })) {
      handleMessage(msg, sess, assistantItem, pendingToolNames)
    }

    sess.history.push(assistantItem)
    broadcast(sess.id, { type: 'session.idle', data: {} })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(message)) {
      // Treat user-triggered abort as a clean idle
      broadcast(sess.id, { type: 'session.idle', data: {} })
    } else {
      broadcast(sess.id, { type: 'session.error', data: { message } })
    }
    if (assistantItem.events.length) sess.history.push(assistantItem)
  } finally {
    sess.abort = null
  }
}

function handleMessage(
  msg: SDKMessage,
  sess: HarnessSession,
  assistantItem: HistoryItem,
  pendingToolNames: Map<string, string>,
): void {
  // Capture claude session ID for multi-turn resume
  if (msg.type === 'system' && msg.subtype === 'init') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sess.claudeSessionId = (msg as any).session_id ?? null
    return
  }

  if (msg.type === 'assistant') {
    const blocks = msg.message.content
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        const ev: PlatformEvent = {
          type: 'message.delta',
          data: { partId: randomUUID(), text: block.text },
        }
        assistantItem.events.push(ev)
        broadcast(sess.id, ev)

      } else if (block.type === 'tool_use') {
        pendingToolNames.set(block.id, block.name)
        const ev: PlatformEvent = {
          type: 'tool.start',
          data: { toolId: block.id, tool: block.name, input: JSON.stringify(block.input) },
        }
        assistantItem.events.push(ev)
        broadcast(sess.id, ev)
      }
    }
    return
  }

  if (msg.type === 'user') {
    const blocks = msg.message.content as Array<{
      type: string
      tool_use_id: string
      content: unknown
    }>
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const toolName = pendingToolNames.get(block.tool_use_id) ?? 'unknown'
        pendingToolNames.delete(block.tool_use_id)
        const output =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content)
        const ev: PlatformEvent = {
          type: 'tool.done',
          data: { toolId: block.tool_use_id, tool: toolName, output },
        }
        assistantItem.events.push(ev)
        broadcast(sess.id, ev)
      }
    }
    return
  }

  if (msg.type === 'result' && msg.subtype !== 'success') {
    broadcast(sess.id, {
      type: 'session.error',
      data: { message: msg.result ?? 'task ended with error' },
    })
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[claude-code-harness] listening on :${PORT}`)
})
