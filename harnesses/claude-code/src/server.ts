/**
 * Cattery claude-code harness — wraps @anthropic-ai/claude-agent-sdk behind
 * the same HTTP contract opencode implements:
 *
 *   POST /session                          → { id }
 *   GET  /session/:id                      → { id }
 *   GET  /session/:id/message              → PlatformHistoryItem[]
 *   POST /session/:id/prompt_async         → 204 (fire-and-forget)
 *   POST /session/:id/abort                → 204
 *   POST /session/:id/answer               → 204 (resolve a pending AskUserQuestion)
 *   GET  /event                            → SSE bus of platform events
 *
 * Events emitted (platform-neutral; same shape opencode emits via its translator):
 *   message.delta / message.thinking       — assistant text/thinking parts
 *   tool.start / tool.done                  — tool calls
 *   question.asked / question.answered      — AskUserQuestion pause + resume
 *   session.idle / session.error / session.title
 */

import express from 'express'
import { randomUUID } from 'node:crypto'
import {
  query,
  getSessionInfo,
  type Options,
  type SDKMessage,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'

// ── Startup: env normalization + diagnostics ─────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.OPENAI_API_KEY
  console.log('[startup] ANTHROPIC_API_KEY: mapped from OPENAI_API_KEY')
}
if (!process.env.ANTHROPIC_BASE_URL && process.env.OPENAI_BASE_URL) {
  process.env.ANTHROPIC_BASE_URL = process.env.OPENAI_BASE_URL
  console.log('[startup] ANTHROPIC_BASE_URL: mapped from OPENAI_BASE_URL')
}
// The new SDK reads ANTHROPIC_AUTH_TOKEN for proxy/gateway auth; mirror it.
if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_API_KEY
}

console.log('[startup] MODEL             :', process.env.MODEL ?? '(not set)')
console.log('[startup] ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL ?? '(not set — will use api.anthropic.com)')
console.log('[startup] ANTHROPIC_API_KEY :', process.env.ANTHROPIC_API_KEY ? '(set)' : '*** NOT SET — will fail ***')

{
  const base = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
  const key  = process.env.ANTHROPIC_API_KEY  ?? ''
  fetch(`${base}/v1/models`, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  })
    .then(r => console.log(`[startup] API probe → HTTP ${r.status}`))
    .catch(e => console.error('[startup] API probe failed:', e.message))
}

const app = express()
app.use(express.json({ limit: '10mb' }))

const PORT    = Number(process.env.PORT ?? 4096)
const MODEL   = process.env.MODEL        ?? 'claude-sonnet-4-6'
const PROMPT  = process.env.AGENT_PROMPT ?? ''
const WORKDIR = process.env.WORK_DIR     ?? '/work'

// ── Platform event types (mirror backend/internal/harness/event.go) ─────────

type PlatformEventType =
  | 'message.delta'
  | 'message.thinking'
  | 'tool.start'
  | 'tool.done'
  | 'question.asked'
  | 'question.answered'
  | 'session.idle'
  | 'session.error'
  | 'session.title'

interface PlatformEvent { type: PlatformEventType; data: unknown }

interface HistoryItem {
  messageId: string
  role: 'user' | 'assistant'
  events: PlatformEvent[]
}

// ── Session state ────────────────────────────────────────────────────────────

interface AnswerPayload {
  questionId: string
  answers: Array<{ question: string; selectedLabels: string[]; notes?: string }>
}

interface PendingQuestion {
  resolve: (a: AnswerPayload) => void
}

interface HarnessSession {
  id: string
  claudeSessionId: string | null
  history: HistoryItem[]
  abort: AbortController | null
  questions: Map<string, PendingQuestion>
}

const sessions   = new Map<string, HarnessSession>()
const sseClients = new Set<(payload: string) => void>()

function broadcast(sessionId: string, ev: PlatformEvent): void {
  const payload = JSON.stringify({ sessionId, type: ev.type, data: ev.data })
  for (const send of sseClients) {
    try { send(payload) } catch { /* ignore closed connections */ }
  }
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

app.get('/session', (_req, res) => {
  res.json([...sessions.keys()])
})

app.post('/session', (_req, res) => {
  const id = randomUUID()
  sessions.set(id, {
    id, claudeSessionId: null, history: [], abort: null,
    questions: new Map(),
  })
  res.json({ id })
})

app.get('/session/:id', (req, res) => {
  const sess = sessions.get(req.params.id)
  if (!sess) return void res.status(404).json({ error: 'not found' })
  res.json({ id: sess.id })
})

app.get('/session/:id/message', (req, res) => {
  const sess = sessions.get(req.params.id)
  res.json(sess?.history ?? [])
})

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
  const sess = sessions.get(req.params.id)
  if (sess) {
    sess.abort?.abort('user aborted')
    for (const q of sess.questions.values()) q.resolve({ questionId: '', answers: [] })
    sess.questions.clear()
  }
  res.status(204).end()
})

app.post('/session/:id/answer', (req, res) => {
  const sess = sessions.get(req.params.id)
  if (!sess) return void res.status(404).end()
  const body = req.body as Partial<AnswerPayload>
  if (!body?.questionId || !Array.isArray(body.answers)) {
    return void res.status(400).end()
  }
  const pending = sess.questions.get(body.questionId)
  if (!pending) return void res.status(404).end()
  sess.questions.delete(body.questionId)
  pending.resolve({ questionId: body.questionId, answers: body.answers })
  res.status(204).end()
})

app.get('/event', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const send = (payload: string) => res.write(`data: ${payload}\n\n`)
  sseClients.add(send)
  req.on('close', () => sseClients.delete(send))
})

// ── Turn runner ──────────────────────────────────────────────────────────────

/**
 * Per-turn state shared between the SDK message loop and the helper that
 * commits events to history. Tracking partIDs by (sdk_msg_id, block_idx) keeps
 * IDs stable across the stream_event → assistant authoritative-update pair.
 */
interface TurnState {
  sess: HarnessSession
  assistantItem: HistoryItem      // built incrementally, pushed to history at end
  msgIdBase: string                // prefix of every partID this turn
  toolPartByCallId: Map<string, string>    // tool_use.id → partId, so user/tool_result can find it
}

async function runPrompt(sess: HarnessSession, userText: string): Promise<void> {
  if (sess.abort) sess.abort.abort('superseded')
  const abort = new AbortController()
  sess.abort = abort

  const isFirst = sess.history.length === 0

  // Record the user turn immediately so a mid-turn refresh sees it.
  const userMsgId = randomUUID()
  sess.history.push({
    messageId: userMsgId,
    role: 'user',
    events: [{ type: 'message.delta', data: { partId: userMsgId, text: userText } }],
  })

  const assistantItem: HistoryItem = {
    messageId: randomUUID(),
    role: 'assistant',
    events: [],
  }
  const turn: TurnState = {
    sess,
    assistantItem,
    msgIdBase: assistantItem.messageId,
    toolPartByCallId: new Map(),
  }

  try {
    const options: Options = {
      model: MODEL,
      maxTurns: 30,
      maxThinkingTokens: 8000,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      cwd: WORKDIR,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY    ?? '',
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '',
        ANTHROPIC_BASE_URL:   process.env.ANTHROPIC_BASE_URL   ?? '',
      },
      stderr: (data) => console.error('[claude stderr]', data.trimEnd()),
      canUseTool: (toolName, input) => handlePermission(sess, toolName, input, abort.signal),
    }
    if (PROMPT)               options.appendSystemPrompt = PROMPT
    if (sess.claudeSessionId) options.resume             = sess.claudeSessionId

    for await (const msg of query({ prompt: userText, options, abortController: abort })) {
      handleSdkMessage(msg, turn)
    }

    sess.history.push(assistantItem)

    // Read the SDK's auto-generated session title BEFORE emitting session.idle.
    // The backend's StreamEventsUntilIdle closes the SSE the moment it sees
    // session.idle, so a `void`-fired title would race the connection close
    // and get dropped before it could be persisted to the DB.
    if (isFirst && sess.claudeSessionId) {
      const title = await readSessionTitle(sess.claudeSessionId, userText)
      if (title) broadcast(sess.id, { type: 'session.title', data: { title } })
    }

    broadcast(sess.id, { type: 'session.idle', data: {} })

  } catch (err: unknown) {
    console.error('[runPrompt] query() threw:', err)
    const message = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(message)) {
      broadcast(sess.id, { type: 'session.idle', data: {} })
    } else {
      broadcast(sess.id, { type: 'session.error', data: { message } })
    }
    if (assistantItem.events.length) sess.history.push(assistantItem)
  } finally {
    sess.abort = null
    for (const q of sess.questions.values()) q.resolve({ questionId: '', answers: [] })
    sess.questions.clear()
  }
}

// ── canUseTool: AskUserQuestion interception ────────────────────────────────

async function handlePermission(
  sess: HarnessSession,
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionResult> {
  if (toolName !== 'AskUserQuestion') {
    return { behavior: 'allow', updatedInput: input }
  }

  const questionId = randomUUID()
  const askEv: PlatformEvent = {
    type: 'question.asked',
    data: { partId: questionId, questions: input.questions ?? [] },
  }
  broadcast(sess.id, askEv)
  // Record on the still-open assistant turn so refresh-after-finish sees it.
  appendStandaloneToCurrentTurn(sess, askEv)

  const answer = await new Promise<AnswerPayload>((resolve) => {
    sess.questions.set(questionId, { resolve })
    signal.addEventListener('abort', () => {
      if (sess.questions.has(questionId)) {
        sess.questions.delete(questionId)
        resolve({ questionId, answers: [] })
      }
    }, { once: true })
  })

  if (!answer.answers.length) {
    return { behavior: 'deny', message: 'User cancelled the question.', interrupt: true }
  }

  const ansEv: PlatformEvent = {
    type: 'question.answered',
    data: { partId: questionId, answers: answer.answers },
  }
  broadcast(sess.id, ansEv)
  appendStandaloneToCurrentTurn(sess, ansEv)

  // The SDK has no public hook to inject a real AskUserQuestionOutput, so we
  // route the user's choice through the deny-message channel. The model reads
  // it as conversation guidance and continues.
  const text = answer.answers.map(a =>
    `Q: ${a.question}\nA: ${a.selectedLabels.join(', ')}${a.notes ? ` (notes: ${a.notes})` : ''}`
  ).join('\n\n')
  return { behavior: 'deny', message: `User answered:\n${text}` }
}

function appendStandaloneToCurrentTurn(sess: HarnessSession, ev: PlatformEvent): void {
  // The active assistant turn isn't in sess.history yet (we push at end of
  // runPrompt). Attach to the most recently constructed turn state via a
  // weak reference on the session: stash it on a hidden slot.
  // Simpler: we know runPrompt builds assistantItem and holds it in the
  // closure. We expose it via this side channel.
  const open = openTurns.get(sess.id)
  if (open) open.assistantItem.events.push(ev)
}

const openTurns = new Map<string, TurnState>()

// ── SDK message handler ──────────────────────────────────────────────────────

function handleSdkMessage(msg: SDKMessage, turn: TurnState): void {
  openTurns.set(turn.sess.id, turn)

  if (msg.type === 'system' && msg.subtype === 'init') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    turn.sess.claudeSessionId = (msg as any).session_id ?? null
    return
  }

  if (msg.type === 'stream_event') {
    handleStreamEvent(msg, turn)
    return
  }

  if (msg.type === 'assistant' && msg.message) {
    handleAssistantMessage(msg, turn)
    return
  }

  if (msg.type === 'user' && msg.message) {
    handleUserMessage(msg, turn)
    return
  }

  if (msg.type === 'result' && msg.subtype !== 'success') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = msg as any
    broadcast(turn.sess.id, {
      type: 'session.error',
      data: { message: String(r.result ?? 'task ended with error') },
    })
  }
}

/**
 * Token-level streaming. With includePartialMessages: true, the SDK forwards
 * raw Anthropic API SSE frames. We track each block's stable partID via
 * (sdk_msg_id, block_idx) → globalIdx so deltas land in the right bubble.
 */
function handleStreamEvent(msg: SDKMessage, turn: TurnState): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (msg as any).event
  if (inner?.type !== 'content_block_delta') return
  if (typeof inner.index !== 'number') return

  const d = inner.delta
  if (d?.type === 'text_delta' && typeof d.text === 'string') {
    emitAndAccumulate(turn, 'message.delta', partIdFor(turn, inner.index, 'text'), d.text)
  } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
    emitAndAccumulate(turn, 'message.thinking', partIdFor(turn, inner.index, 'thinking'), d.thinking)
  }
}

// PartID encodes the kind so text and thinking never collide even if the
// upstream sends them on the same content_block.index.
function partIdFor(turn: TurnState, blockIdx: number, kind: 'text' | 'thinking' | 'tool'): string {
  const tag = kind === 'text' ? 't' : kind === 'thinking' ? 'k' : 'u'
  return `${turn.msgIdBase}_${tag}${blockIdx}`
}

/**
 * Authoritative assistant message: emit tool.start for tool_use blocks. Text
 * and thinking are intentionally NOT handled here — stream_event has already
 * accumulated them with token-level deltas, and the `assistant` event's content
 * array is unordered relative to stream indices, so re-committing here would
 * duplicate parts under a different partId.
 */
function handleAssistantMessage(msg: SDKMessage, turn: TurnState): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = (msg as any).message
  const blocks: Array<{ type: string; name?: string; id?: string; input?: unknown }> =
    message?.content ?? []

  blocks.forEach((block, idx) => {
    if (block.type !== 'tool_use' || !block.id || !block.name) return
    const partId = partIdFor(turn, idx, 'tool')
    const inputJSON = JSON.stringify(block.input ?? {})
    const ev: PlatformEvent = {
      type: 'tool.start',
      data: { toolId: block.id, tool: block.name, input: inputJSON, partId },
    }
    turn.assistantItem.events.push(ev)
    broadcast(turn.sess.id, ev)
    turn.toolPartByCallId.set(block.id, partId)
  })
}

function handleUserMessage(msg: SDKMessage, turn: TurnState): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = (msg as any).message
  const blocks: Array<{
    type: string; tool_use_id?: string; content?: unknown; is_error?: boolean
  }> = message?.content ?? []

  for (const block of blocks) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue
    const partId = turn.toolPartByCallId.get(block.tool_use_id)
    const output = Array.isArray(block.content)
      ? (block.content as Array<{ type?: string; text?: string }>)
          .map(c => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('')
      : typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? '')

    // Recover the tool name from the matching tool.start in history.
    const startEv = turn.assistantItem.events.find(e =>
      e.type === 'tool.start' &&
      (e.data as { toolId?: string }).toolId === block.tool_use_id,
    )
    const toolName = (startEv?.data as { tool?: string } | undefined)?.tool ?? 'unknown'

    const ev: PlatformEvent = {
      type: 'tool.done',
      data: {
        toolId: block.tool_use_id,
        tool: toolName,
        output,
        partId,
      },
    }
    turn.assistantItem.events.push(ev)
    broadcast(turn.sess.id, ev)
  }
}

// ── Text/thinking accumulation ──────────────────────────────────────────────

function emitAndAccumulate(
  turn: TurnState,
  type: 'message.delta' | 'message.thinking',
  partId: string,
  delta: string,
): void {
  // Live stream: incremental.
  broadcast(turn.sess.id, { type, data: { partId, text: delta } })
  // History: coalesce into a single event per partId so a refresh after the
  // turn ends restores the full text without the loader needing to append.
  const existing = turn.assistantItem.events.find(e =>
    e.type === type && (e.data as { partId?: string }).partId === partId,
  )
  if (existing) {
    (existing.data as { text: string }).text += delta
  } else {
    turn.assistantItem.events.push({ type, data: { partId, text: delta } })
  }
}

// ── Auto title ──────────────────────────────────────────────────────────────

/**
 * Read the SDK's auto-generated `aiTitle` from the session's JSONL sidecar.
 * The SDK's child process generates a title in the background after the first
 * turn and persists it under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * `getSessionInfo()` resolves `customTitle || aiTitle || lastPrompt || ... || firstPrompt`,
 * so before the aiTitle lands, `summary` equals `firstPrompt` — we poll until
 * the two diverge, with an overall budget of ~8s.
 */
async function readSessionTitle(claudeSessionId: string, firstPrompt: string): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 800))
    try {
      const info = await getSessionInfo(claudeSessionId, { dir: WORKDIR })
      if (!info?.summary) continue
      if (info.customTitle) return info.customTitle
      // aiTitle has landed iff resolved summary differs from the raw firstPrompt.
      if (info.summary !== info.firstPrompt && info.summary !== firstPrompt) {
        return info.summary
      }
    } catch (err) {
      console.error('[readSessionTitle] getSessionInfo failed:', err instanceof Error ? err.message : err)
    }
  }
  return null
}

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[claude-code-harness] listening on :${PORT}`)
})
