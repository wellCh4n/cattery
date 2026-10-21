/**
 * Cattery pi harness — runs @earendil-works/pi-agent-core behind the platform
 * HTTP contract:
 *
 *   GET    /session                        → [id]  (readiness probe)
 *   POST   /session {id, model, provider, baseUrl, apiKey, thinkingLevel?, smallModel?}
 *                                          → { id }  (idempotent: reopens an existing transcript,
 *                                                     switching its model if it differs)
 *   GET    /session/:id                    → { id }
 *   DELETE /session/:id                    → 204 (abort + delete transcript)
 *   GET    /session/:id/message            → PlatformHistoryItem[]
 *   POST   /session/:id/prompt_async       → 204 (fire-and-forget)
 *   POST   /session/:id/abort              → 204
 *   GET    /event                          → SSE bus of platform events
 *
 * One sandbox serves every session of a project; each session carries its own
 * model. The backend sends the model's endpoint and key with every POST
 * /session (it re-registers before each prompt); they are kept in memory only,
 * never written to the transcript.
 *
 * Events are emitted already in platform shape (see
 * backend/internal/harness/event.go), wrapped with `sessionId` for routing:
 *   message.delta / message.thinking / tool.start / tool.done
 *   session.title / session.error / session.idle
 *
 * Each session's transcript (AgentMessage[]) is persisted on the workspace PVC,
 * so sessions survive sandbox restarts. History is derived from the transcript
 * rather than kept separately, so live stream and replay share one source.
 */

import express from 'express'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Agent, type AgentEvent, type AgentMessage, type ThinkingLevel } from '@earendil-works/pi-agent-core'
import { clampThinkingLevel, createModels, createProvider, envApiKeyAuth, type Api, type AssistantMessage, type Model, type ModelThinkingLevel, type Provider } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { createTools } from './tools.ts'
import { TITLE_PROMPT, titleInput, parseTitle } from './title.ts'

// ── Config ───────────────────────────────────────────────────────────────────

const PORT       = Number(process.env.PORT ?? 1114)
const WORKDIR    = process.env.WORK_DIR ?? '/work'
const THINKING   = (process.env.THINKING_LEVEL ?? 'high') as ThinkingLevel
const PROMPT     = process.env.AGENT_PROMPT ?? ''
const SKILLS_DIR = process.env.SKILLS_DIR ?? path.join(process.env.HOME ?? '/home/node', '.agents/skills')
// Dot-dir on the workspace PVC: transcripts survive sandbox restarts and stay
// out of the way of project files.
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? path.join(WORKDIR, '.cattery/sessions')

console.log('[startup] SESSIONS:', SESSIONS_DIR)

// ── Models ───────────────────────────────────────────────────────────────────

// Provider ids are pi-ai provider ids, set per provider in the backend's model
// config. "custom" is any other OpenAI-compatible endpoint, spoken to as plain
// chat completions.
interface ModelRef { provider: string; id: string }
interface Gateway { baseUrl: string; apiKey: string }
const trimUrl = (u: string) => u.replace(/\/+$/, '')

const models = createModels()
models.setProvider(anthropicProvider())
models.setProvider(deepseekProvider())
models.setProvider(openaiProvider())
models.setProvider(createProvider({
  id: 'custom', auth: { apiKey: envApiKeyAuth('API key', []) }, models: [], api: openAICompletionsApi(),
}))

// Keep the catalog entry (context window, thinking map, DeepSeek compat flags
// such as reasoning_content replay) and only swap in the configured endpoint.
// pi auto-detects DeepSeek quirks from provider id OR URL, and a gateway URL
// never contains deepseek.com — so reusing the built-in provider matters.
function resolveModel(ref: ModelRef, baseUrl: string): Model<Api> {
  const catalog = ref.provider === 'custom' ? undefined : models.getModel(ref.provider, ref.id)
  if (!catalog) console.warn(`[model] ${ref.provider}/${ref.id} not in pi catalog; using generic defaults`)
  const base = catalog ?? genericModel(ref)
  return { ...base, ...(baseUrl ? { baseUrl } : {}) } as Model<Api>
}

function genericModel(ref: ModelRef): Model<Api> {
  const api = ref.provider === 'anthropic' ? 'anthropic-messages'
    : ref.provider === 'openai' ? 'openai-responses' : 'openai-completions'
  return {
    id: ref.id, name: ref.id, api, provider: ref.provider, baseUrl: '',
    reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 32_000,
  } as Model<Api>
}

// ── System prompt ────────────────────────────────────────────────────────────

async function listSkills(): Promise<Array<{ name: string; description: string; file: string }>> {
  const out: Array<{ name: string; description: string; file: string }> = []
  let dirs: string[] = []
  try { dirs = await fs.readdir(SKILLS_DIR) } catch { return out }
  for (const d of dirs.sort()) {
    const file = path.join(SKILLS_DIR, d, 'SKILL.md')
    let body: string
    try { body = await fs.readFile(file, 'utf8') } catch { continue }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? ''
    const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '')
    const description = field('description')
    if (description) out.push({ name: field('name') ?? d, description, file })
  }
  return out
}

async function buildSystemPrompt(): Promise<string> {
  const parts = [
    `You are a coding agent working in a shared project workspace at ${WORKDIR}.`,
    'Use the tools to inspect and change files and to run commands. Prefer reading code before editing it, ' +
      'make focused changes, and verify them (build, tests) when practical. Be concise in replies.',
    `Relative paths resolve against ${WORKDIR}. Today is ${new Date().toISOString().slice(0, 10)}.`,
  ]
  const skills = await listSkills()
  if (skills.length) {
    parts.push(
      '<skills>\nThe following skills are available. When a task matches one, read its SKILL.md with the ' +
      'read tool and follow it; resolve paths in it relative to the skill directory.\n' +
      skills.map(s => `- ${s.name}: ${s.description} (${s.file})`).join('\n') +
      '\n</skills>',
    )
  }
  if (PROMPT) parts.push(PROMPT)
  return parts.join('\n\n')
}

// ── Platform events ──────────────────────────────────────────────────────────

interface PlatformEvent { type: string; data: unknown }
interface HistoryItem { messageId: string; role: 'user' | 'assistant'; events: PlatformEvent[] }

const sseClients = new Set<(payload: string) => void>()

function broadcast(sessionId: string, ev: PlatformEvent): void {
  const payload = JSON.stringify({ sessionId, type: ev.type, data: ev.data })
  for (const send of sseClients) {
    try { send(payload) } catch { /* closed connection */ }
  }
}

// partIds derive from the assistant message timestamp + content index, so the
// live stream and transcript replay produce identical ids.
const partId = (msg: { timestamp: number }, kind: 't' | 'k', idx: number) => `a${msg.timestamp}_${kind}${idx}`

function toolOutput(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? []).map(c => (c.type === 'text' ? c.text ?? '' : '')).join('')
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c?.type === 'text' ? c.text : '')).join('')
  return ''
}

/** Rebuild platform history from a transcript: one item per user prompt and one per agent run. */
function toHistory(messages: AgentMessage[]): HistoryItem[] {
  const items: HistoryItem[] = []
  let current: HistoryItem | null = null
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({
        messageId: `u${m.timestamp}`, role: 'user',
        events: [{ type: 'message.delta', data: { partId: `u${m.timestamp}`, text: userText(m.content) } }],
      })
      current = null
      continue
    }
    if (m.role !== 'assistant' && m.role !== 'toolResult') continue
    if (!current) {
      current = { messageId: `r${m.timestamp}`, role: 'assistant', events: [] }
      items.push(current)
    }
    if (m.role === 'assistant') {
      m.content.forEach((b, i) => {
        if (b.type === 'text' && b.text) {
          current!.events.push({ type: 'message.delta', data: { partId: partId(m, 't', i), text: b.text } })
        } else if (b.type === 'thinking' && b.thinking) {
          current!.events.push({ type: 'message.thinking', data: { partId: partId(m, 'k', i), text: b.thinking } })
        } else if (b.type === 'toolCall') {
          toolNames.set(b.id, b.name)
          current!.events.push({ type: 'tool.start', data: { toolId: b.id, tool: b.name, input: JSON.stringify(b.arguments ?? {}) } })
        }
      })
      if (m.stopReason === 'error' && m.errorMessage) {
        current.events.push({ type: 'session.error', data: { message: m.errorMessage } })
      }
    } else {
      current.events.push({
        type: 'tool.done',
        data: {
          toolId: m.toolCallId, tool: toolNames.get(m.toolCallId) ?? m.toolName,
          output: toolOutput(m.content), parsed: m.isError ? undefined : m.details ?? undefined,
        },
      })
    }
  }
  return items
}

// ── Sessions ─────────────────────────────────────────────────────────────────

// gateway is never persisted: a session reopened from disk has none until the
// backend re-registers it, which it always does before prompting.
interface SmallModel extends Gateway { model: string; provider: string }
interface Session {
  id: string
  model: ModelRef
  gateway: Gateway
  agent: Agent
  titled: boolean
  titleAttempted: boolean
  smallModel?: SmallModel
  busy: boolean
  titleAbort?: AbortController
  persistQueue?: Promise<void>
  run?: Promise<void>
}
interface Transcript { model: ModelRef; messages: AgentMessage[]; titleAttempted?: boolean }

const sessions = new Map<string, Session>()
// Session ids come from the backend (UUIDs); reject anything path-like.
const validId = (id: string) => /^[A-Za-z0-9-]{1,64}$/.test(id)
const transcriptPath = (id: string) => path.join(SESSIONS_DIR, `${id}.json`)

function persist(sess: Session): Promise<void> {
  // Serialize checkpoints so an earlier message cannot overwrite the title-attempt flag.
  const pending = (sess.persistQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (sessions.get(sess.id) !== sess) return
    const file = transcriptPath(sess.id)
    const tmp = `${file}.${randomUUID()}.tmp`
    const data: Transcript = { model: sess.model, messages: sess.agent.state.messages, titleAttempted: sess.titleAttempted }
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(data))
    await fs.rename(tmp, file)
  })
  sess.persistQueue = pending
  return pending
}

const NO_GATEWAY: Gateway = { baseUrl: '', apiKey: '' }

async function newSession(id: string, ref: ModelRef, gateway: Gateway, messages: AgentMessage[], titleAttempted = false): Promise<Session> {
  const sess = { id, model: ref, gateway, titled: messages.some(m => m.role === 'user'), titleAttempted, busy: false } as Session
  sess.agent = new Agent({
    initialState: {
      // The system prompt is rebuilt on every load (see openSession) so prompt
      // and skill changes reach existing sessions after a sandbox restart.
      systemPrompt: await buildSystemPrompt(),
      model: resolveModel(ref, gateway.baseUrl),
      thinkingLevel: THINKING,
      tools: createTools(WORKDIR),
      messages,
    },
    streamFn: models.streamSimple.bind(models),
    // Read on every request, so a re-registration with a new key applies at once.
    getApiKey: () => sess.gateway.apiKey || undefined,
    sessionId: id,
  })
  wire(sess)
  sessions.set(id, sess)
  return sess
}

function wire(sess: Session): void {
  sess.agent.subscribe(async (ev: AgentEvent) => {
    forward(sess, ev)
    // Checkpoint after each finished message so a crash mid-run loses at most
    // the in-flight message.
    if (ev.type === 'message_end') await persist(sess).catch(err => console.error('[persist]', err))
  })
}

function forward(sess: Session, ev: AgentEvent): void {
  switch (ev.type) {
    case 'message_update': {
      const e = ev.assistantMessageEvent
      if (e.type === 'text_delta') {
        broadcast(sess.id, { type: 'message.delta', data: { partId: partId(e.partial, 't', e.contentIndex), text: e.delta } })
      } else if (e.type === 'thinking_delta') {
        broadcast(sess.id, { type: 'message.thinking', data: { partId: partId(e.partial, 'k', e.contentIndex), text: e.delta } })
      }
      return
    }
    case 'tool_execution_start':
      broadcast(sess.id, { type: 'tool.start', data: { toolId: ev.toolCallId, tool: ev.toolName, input: JSON.stringify(ev.args ?? {}) } })
      return
    case 'tool_execution_end':
      broadcast(sess.id, {
        type: 'tool.done',
        data: {
          toolId: ev.toolCallId, tool: ev.toolName,
          output: toolOutput(ev.result?.content), parsed: ev.isError ? undefined : ev.result?.details ?? undefined,
        },
      })
      return
  }
}

async function openSession(id: string): Promise<Session | null> {
  if (!validId(id)) return null
  const cached = sessions.get(id)
  if (cached) return cached
  let data: Transcript
  try {
    data = JSON.parse(await fs.readFile(transcriptPath(id), 'utf8'))
  } catch {
    return null
  }
  // Drop persisted system messages; newSession() installs the current prompt.
  return newSession(id, data.model, NO_GATEWAY, data.messages.filter(m => m.role !== 'system'),
    data.titleAttempted ?? data.messages.some(m => m.role === 'assistant' && m.stopReason === 'stop'))
}

// Takes effect from the next turn. The transcript carries over; pi-ai drops
// other models' thinking blocks and normalizes tool-call ids when replaying it.
async function switchModel(sess: Session, ref: ModelRef, gateway: Gateway): Promise<void> {
  sess.model = ref
  sess.gateway = gateway
  sess.agent.state.model = resolveModel(ref, gateway.baseUrl)
  await persist(sess)
}

async function generateTitle(sess: Session, text: string, reply: AssistantMessage): Promise<void> {
  // One attempt after the first successful response, persisted across restarts.
  sess.titleAttempted = true
  await persist(sess)
  const small = sess.smallModel
  if (!small) return
  const controller = new AbortController()
  sess.titleAbort = controller
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const result = await models.completeSimple(resolveModel({ provider: small.provider, id: small.model }, small.baseUrl), {
      systemPrompt: TITLE_PROMPT,
      messages: [{ role: 'user', content: titleInput(text, toolOutput(reply.content)), timestamp: Date.now() }],
    }, { apiKey: small.apiKey, maxTokens: 512, signal: controller.signal })
    if (controller.signal.aborted) return
    const title = parseTitle(result)
    if (title && sessions.get(sess.id) === sess) {
      broadcast(sess.id, { type: 'session.title', data: { title } })
    }
  } catch {
    // Title failure must never fail the user's run or replace its fallback title.
    console.warn('[title] generation failed for', sess.id)
  } finally {
    clearTimeout(timer)
    sess.titleAbort = undefined
  }
}

async function runPrompt(sess: Session, text: string): Promise<void> {
  if (!sess.titled) {
    sess.titled = true
    const title = text.split('\n').find(l => l.trim())?.trim() ?? ''
    if (title) broadcast(sess.id, { type: 'session.title', data: { title: title.length > 60 ? title.slice(0, 57) + '…' : title } })
  }
  try {
    await sess.agent.prompt(text)
    const last = [...sess.agent.state.messages].reverse().find(m => m.role === 'assistant') as AssistantMessage | undefined
    if (last?.stopReason === 'error') {
      broadcast(sess.id, { type: 'session.error', data: { message: last.errorMessage ?? 'model request failed' } })
    } else if (last?.stopReason === 'stop' && !sess.titleAttempted) {
      await generateTitle(sess, text, last).catch(() => console.warn('[title] checkpoint failed for', sess.id))
    }
  } catch (err) {
    console.error('[runPrompt]', err)
    broadcast(sess.id, { type: 'session.error', data: { message: err instanceof Error ? err.message : String(err) } })
  } finally {
    if (sessions.get(sess.id) === sess) await persist(sess).catch(err => console.error('[persist]', err))
    sess.busy = false
    broadcast(sess.id, { type: 'session.idle', data: {} })
  }
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '10mb' }))

let stopping: Promise<void> | undefined
const sessionRequests = new Set<Promise<void>>()
app.use((req, res, next) => {
  // Readiness and event streams remain available while sessions are released.
  if (!req.path.startsWith('/session') || (req.method === 'GET' && req.path === '/session')) return next()
  if (stopping) return void res.status(503).json({ error: 'agent is stopping' })
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  sessionRequests.add(pending)
  const done = () => { sessionRequests.delete(pending); complete() }
  res.once('finish', done)
  res.once('close', done)
  next()
})

app.post('/stop', async (_req, res, next) => {
  stopping ??= (async () => {
    await Promise.all([...sessionRequests])
    const active = [...sessions.values()]
    for (const sess of active) {
      sess.agent.abort()
      sess.titleAbort?.abort()
    }
    await Promise.allSettled(active.map(sess => sess.run))
    await Promise.all(active.map(sess => persist(sess)))
    sessions.clear()
  })().finally(() => { stopping = undefined })
  try {
    await stopping
    res.status(204).end()
  } catch (err) { next(err) }
})


app.get('/session', (_req, res) => {
  res.json([...sessions.keys()])
})

app.post('/session', async (req, res) => {
  const { id = randomUUID(), model, provider, baseUrl, apiKey, thinkingLevel, smallModel } = (req.body ?? {}) as {
    id?: string; model?: string; provider?: string; baseUrl?: string; apiKey?: string; thinkingLevel?: string; smallModel?: SmallModel
  }
  if (!validId(id)) return void res.status(400).json({ error: 'invalid id' })
  if (!model || !provider || !baseUrl || !apiKey) {
    return void res.status(400).json({ error: 'model, provider, baseUrl and apiKey are required' })
  }
  const ref: ModelRef = { provider, id: model }
  const gateway: Gateway = { baseUrl: trimUrl(baseUrl), apiKey }
  const existing = await openSession(id)
  let sess: Session
  if (!existing) {
    sess = await newSession(id, ref, gateway, [])
  } else {
    // Re-registering with a different model (or endpoint) switches it.
    const changed = existing.model.id !== ref.id || existing.model.provider !== ref.provider ||
      existing.gateway.baseUrl !== gateway.baseUrl
    if (changed) {
      if (existing.busy) return void res.status(409).json({ error: 'session is busy' })
      await switchModel(existing, ref, gateway)
    } else {
      existing.gateway = gateway
    }
    sess = existing
  }
  sess.smallModel = smallModel
  // The session's effort, applied from the next turn and clamped to the
  // levels the model supports (e.g. DeepSeek has no "medium").
  if (thinkingLevel) {
    sess.agent.state.thinkingLevel = clampThinkingLevel(sess.agent.state.model, thinkingLevel as ModelThinkingLevel) as ThinkingLevel
  }
  if (!existing) await persist(sess)
  res.json({ id })
})

app.get('/session/:id', async (req, res) => {
  const sess = await openSession(req.params.id)
  if (!sess) return void res.status(404).json({ error: 'not found' })
  res.json({ id: sess.id })
})

app.delete('/session/:id', async (req, res) => {
  const sess = await openSession(req.params.id)
  if (!sess) return void res.status(404).end()
  sess.agent.abort()
  sess.titleAbort?.abort()
  sessions.delete(sess.id)
  await sess.persistQueue?.catch(() => {})
  await fs.rm(transcriptPath(sess.id), { force: true })
  res.status(204).end()
})

app.get('/session/:id/message', async (req, res) => {
  const sess = await openSession(req.params.id)
  res.json(sess ? toHistory(sess.agent.state.messages) : [])
})

app.post('/session/:id/prompt_async', async (req, res) => {
  const sess = await openSession(req.params.id)
  if (!sess) return void res.status(404).end()
  const parts: Array<{ type: string; text: string }> = req.body?.parts ?? []
  const text = parts.find(p => p.type === 'text')?.text?.trim() ?? ''
  if (!text) return void res.status(400).end()
  if (sess.busy) return void res.status(409).json({ error: 'session is busy' })
  sess.busy = true
  res.status(204).end()
  sess.run = runPrompt(sess, text)
})

app.post('/session/:id/abort', async (req, res) => {
  const sess = await openSession(req.params.id)
  sess?.agent.abort()
  sess?.titleAbort?.abort()
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pi-harness] listening on :${PORT}`)
})
