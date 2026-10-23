/**
 * Cattery pi harness — runs @earendil-works/pi-coding-agent behind the platform
 * HTTP contract:
 *
 *   GET    /session                        → [id]  (readiness probe)
 *   POST   /session {id, model, provider, baseUrl, apiKey, thinkingLevel?, smallModel?}
 *                                          → { id }  (idempotent: reopens an existing transcript,
 *                                                     switching its model if it differs)
 *   GET    /session/:id                    → { id }
 *   DELETE /session/:id                    → 204 (abort + delete transcript)
 *   GET    /session/:id/message            → PlatformHistoryItem[]  (snapshot; session.state carries
 *                                                     the seq of the last event it reflects)
 *   POST   /session/:id/prompt_async       → 204 (run started) | 202 (busy: steered into the run)
 *   DELETE /session/:id/queue/:index {text} → { messages }  (withdraw a steered message)
 *   POST   /session/:id/questionnaire/:toolId → 204 (answer/cancel a pending tool)
 *   POST   /session/:id/abort              → 204
 *   GET    /event                          → SSE bus of platform events, each with a rising seq
 *
 * One sandbox serves every session of a project; each session carries its own
 * model. The backend sends the model's endpoint and key with every POST
 * /session (it re-registers before each prompt); they are kept in memory only,
 * never written to the transcript.
 *
 * Events are emitted already in platform shape (see
 * backend/internal/harness/event.go), wrapped with `sessionId` for routing:
 *   message.delta / message.thinking / message.thinking.done / tool.start / tool.done
 *   message.user (a steered message reached the model) / session.queue (steered, not yet delivered)
 *   session.title / session.usage / session.error / session.idle
 *
 * SDK JSONL sessions are persisted on the workspace PVC,
 * so sessions survive sandbox restarts. History is derived from the transcript
 * rather than kept separately, so live stream and replay share one source.
 */

import express, { type RequestHandler, type ErrorRequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { type AgentMessage, type ThinkingLevel } from '@earendil-works/pi-agent-core'
import { InMemoryCredentialStore, createProvider, envApiKeyAuth, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { Questionnaire, prepareQuestionnaireArguments } from './questionnaire.ts'
import { TITLE_PROMPT, titleInput, parseTitle } from './title.ts'

// ── Config ───────────────────────────────────────────────────────────────────

const PORT       = Number(process.env.PORT ?? 1114)
const WORKDIR    = process.env.WORK_DIR ?? homedir()
const THINKING   = (process.env.THINKING_LEVEL ?? 'high') as ThinkingLevel
const PROMPT     = process.env.AGENT_PROMPT ?? ''
const SKILLS_DIR = process.env.SKILLS_DIR ?? '/cattery/global-skills'
// Dot-dir on the workspace PVC: transcripts survive sandbox restarts and stay
// out of the way of project files.
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? path.join(WORKDIR, '.cattery/sessions')

// Align the harness process with the SDK tools and the web terminal too.
process.chdir(WORKDIR)
console.log('[startup] SESSIONS:', SESSIONS_DIR)

// ── Models ───────────────────────────────────────────────────────────────────

// Provider ids are pi-ai provider ids, set per provider in the backend's model
// config. "custom" is any other OpenAI-compatible endpoint, spoken to as plain
// chat completions.
interface ModelRef { provider: string; id: string }
interface Gateway { baseUrl: string; apiKey: string }
const trimUrl = (u: string) => u.replace(/\/+$/, '')

const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
models.registerNativeProvider(createProvider({
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

// ── Platform events ──────────────────────────────────────────────────────────

interface PlatformEvent { type: string; data: unknown }
interface HistoryItem { messageId: string; role: 'user' | 'assistant'; events: PlatformEvent[] }

const sseClients = new Set<(payload: string) => void>()

// Every event carries a rising seq, and a history snapshot reports the last seq
// it reflects, so a client that joins mid-run applies only later events. Seeded
// from the clock so it keeps rising across harness restarts.
let eventSeq = Date.now() * 1000

function broadcast(sessionId: string, ev: PlatformEvent): void {
  const payload = JSON.stringify({ sessionId, seq: ++eventSeq, type: ev.type, data: ev.data })
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

// Re-steered messages can share a millisecond, so later ones get a suffix. The
// live stream and replay walk user messages in the same order and agree.
function userPartId(timestamp: number, previous: { timestamp: number; count: number } | undefined): { id: string; timestamp: number; count: number } {
  const count = previous?.timestamp === timestamp ? previous.count + 1 : 0
  return { id: count ? `u${timestamp}_${count}` : `u${timestamp}`, timestamp, count }
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c?.type === 'text' ? c.text : '')).join('')
  return ''
}

/** Rebuild platform history from a transcript: one item per user prompt and one per agent run. */
function toHistory(messages: AgentMessage[], thinkingMs: Map<string, number>): HistoryItem[] {
  const items: HistoryItem[] = []
  let current: HistoryItem | null = null
  const toolNames = new Map<string, string>()
  let lastUser: ReturnType<typeof userPartId> | undefined
  for (const m of messages) {
    if (m.role === 'user') {
      lastUser = userPartId(m.timestamp, lastUser)
      items.push({
        messageId: lastUser.id, role: 'user',
        events: [{ type: 'message.delta', data: { partId: lastUser.id, text: userText(m.content) } }],
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
          const id = partId(m, 'k', i)
          current!.events.push({ type: 'message.thinking', data: { partId: id, text: b.thinking } })
          const durationMs = thinkingMs.get(id)
          if (durationMs !== undefined) current!.events.push({ type: 'message.thinking.done', data: { partId: id, durationMs } })
        } else if (b.type === 'toolCall') {
          toolNames.set(b.id, b.name)
          current!.events.push({ type: 'tool.start', data: { toolId: b.id, tool: b.name, input: JSON.stringify(b.name === 'questionnaire' ? prepareQuestionnaireArguments(b.arguments) : b.arguments ?? {}) } })
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
          output: toolOutput(m.content), parsed: m.isError ? undefined : m.details,
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
  sdk: AgentSession
  manager: SessionManager
  runtime: ModelRuntime
  titled: boolean
  titleAttempted: boolean
  smallModel?: SmallModel
  busy: boolean
  questionnaire: Questionnaire
  titleAbort?: AbortController
  // Start time of each thinking block still streaming, keyed by partId.
  thinkingStarts: Map<string, number>
  lastUser?: ReturnType<typeof userPartId>
  // Broadcast but not yet in the transcript; history snapshots include them.
  live: LiveState
  persistQueue?: Promise<void>
  run?: Promise<void>
}
interface LiveState {
  user?: { partId: string; text: string }
  // The assistant message still streaming: text and thinking so far, per partId.
  assistant?: { timestamp: number; blocks: Map<string, PlatformEvent>; thinkingDone: PlatformEvent[] }
  // Finished tools whose result message is not persisted yet, by toolCallId.
  toolDone: Map<string, PlatformEvent>
}
interface SessionMetadata { version: 2; model: ModelRef; titleAttempted: boolean }

const sessions = new Map<string, Session>()
// Session ids come from the backend (UUIDs); reject anything path-like.
const validId = (id: string) => /^[A-Za-z0-9-]{1,64}$/.test(id)
const transcriptPath = (id: string) => path.join(SESSIONS_DIR, `${id}.json`)

function persist(sess: Session): Promise<void> {
  // Only platform metadata is stored here; the SDK persists the conversation.
  const pending = (sess.persistQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (sessions.get(sess.id) !== sess) return
    const file = transcriptPath(sess.id)
    const tmp = `${file}.${randomUUID()}.tmp`
    const data: SessionMetadata = { version: 2, model: sess.model, titleAttempted: sess.titleAttempted }
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(data))
    await fs.rename(tmp, file)
  })
  sess.persistQueue = pending
  return pending
}

const NO_GATEWAY: Gateway = { baseUrl: '', apiKey: '' }

async function newSession(id: string, ref: ModelRef, gateway: Gateway, titleAttempted = false): Promise<Session> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  const manager = SessionManager.open(path.join(SESSIONS_DIR, `${id}.jsonl`), SESSIONS_DIR, WORKDIR)
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  runtime.registerNativeProvider(createProvider({
    id: 'custom', auth: { apiKey: envApiKeyAuth('API key', []) }, models: [], api: openAICompletionsApi(),
  }))
  const model = resolveModel(ref, gateway.baseUrl)
  if (gateway.baseUrl) runtime.registerProvider(ref.provider, { models: [model], baseUrl: gateway.baseUrl })
  if (gateway.apiKey) await runtime.setRuntimeApiKey(ref.provider, gateway.apiKey)
  const agentDir = path.join(WORKDIR, '.cattery/agent')
  // Deliver every steered message at the next model request, not one per request.
  const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', steeringMode: 'all' })
  const resourceLoader = new DefaultResourceLoader({
    cwd: WORKDIR, agentDir, settingsManager,
    additionalSkillPaths: [SKILLS_DIR, path.join(WORKDIR, '.agents/skills')],
    noExtensions: true, noThemes: true,
    appendSystemPrompt: [
      'You are working in a shared Cattery project workspace. Be concise in replies.',
      ...(PROMPT ? [PROMPT] : []),
    ],
  })
  await resourceLoader.reload()
  const questionnaire = new Questionnaire()
  const { session: sdk } = await createAgentSession({
    cwd: WORKDIR, agentDir, modelRuntime: runtime, model,
    thinkingLevel: manager.getEntries().length ? undefined : THINKING,
    sessionManager: manager, settingsManager, resourceLoader,
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'questionnaire'],
    customTools: [questionnaire.tool],
  })
  const sess: Session = { id, model: ref, gateway, sdk, manager, runtime,
    titled: manager.getEntries().some(e => e.type === 'message' && e.message.role === 'user'), titleAttempted, busy: false, questionnaire, thinkingStarts: new Map(), live: { toolDone: new Map() } }
  sdk.subscribe(ev => forward(sess, ev))
  sessions.set(id, sess)
  return sess
}

// Thinking durations are stored as custom transcript entries, which never reach the model.
const THINKING_ENTRY = 'cattery.thinking'
interface ThinkingEntryData { partId: string; durationMs: number }

// Context window fill and session token totals, straight from the SDK. Cost is
// left out: pi prices from its catalog, which a gateway may not match.
// reserveTokens is the auto-compaction buffer: compaction runs once the context
// passes contextWindow - reserveTokens. contextTokens is null right after a
// compaction, until the next response reports a size.
function usage(sess: Session): PlatformEvent | null {
  const stats = sess.sdk.getSessionStats()
  const ctx = stats.contextUsage
  if (!ctx) return null
  const compaction = sess.sdk.settingsManager.getCompactionSettings(sess.sdk.model)
  const { input, output, cacheRead, cacheWrite } = stats.tokens
  return {
    type: 'session.usage',
    data: {
      contextTokens: ctx.tokens, contextWindow: ctx.contextWindow,
      reserveTokens: compaction.enabled ? compaction.reserveTokens : 0,
      tokens: { input, output, cacheRead, cacheWrite },
      userMessages: stats.userMessages, toolCalls: stats.toolCalls,
    },
  }
}

function broadcastUsage(sess: Session): void {
  const ev = usage(sess)
  if (ev) broadcast(sess.id, ev)
}

// UI history comes from the full persisted branch, not the compacted LLM context.
function history(sess: Session): HistoryItem[] {
  const messages: AgentMessage[] = []
  const thinkingMs = new Map<string, number>()
  for (const entry of sess.manager.getBranch()) {
    if (entry.type === 'message') messages.push(entry.message)
    else if (entry.type === 'custom' && entry.customType === THINKING_ENTRY) {
      const d = entry.data as ThinkingEntryData
      thinkingMs.set(d.partId, d.durationMs)
    }
  }
  const items = toHistory(messages, thinkingMs)
  appendLive(sess.live, items)
  return items
}

// Adds what was broadcast but not persisted, so the snapshot matches the event
// stream up to eventSeq. The SDK persists each message right after emitting its
// message_end, synchronously, so nothing falls between the two.
function appendLive(live: LiveState, items: HistoryItem[]): void {
  const reply = (timestamp: number) => {
    const last = items.at(-1)
    if (last?.role === 'assistant') return last
    const item: HistoryItem = { messageId: `r${timestamp}`, role: 'assistant', events: [] }
    items.push(item)
    return item
  }
  if (live.toolDone.size) reply(Date.now()).events.push(...live.toolDone.values())
  if (live.user) {
    items.push({ messageId: live.user.partId, role: 'user', events: [{ type: 'message.delta', data: live.user }] })
  }
  if (live.assistant) reply(live.assistant.timestamp).events.push(...live.assistant.blocks.values(), ...live.assistant.thinkingDone)
}

function liveBlock(sess: Session, msg: { timestamp: number }, id: string, type: 'message.delta' | 'message.thinking', delta: string): void {
  const a = sess.live.assistant ??= { timestamp: msg.timestamp, blocks: new Map(), thinkingDone: [] }
  const prev = a.blocks.get(id)?.data as { text: string } | undefined
  a.blocks.set(id, { type, data: { partId: id, text: (prev?.text ?? '') + delta } })
}

const queued = (sess: Session) => [...sess.sdk.getSteeringMessages(), ...sess.sdk.getFollowUpMessages()]

function forward(sess: Session, ev: AgentSessionEvent): void {
  switch (ev.type) {
    case 'message_start':
      if (ev.message.role !== 'user') return
      // Every prompt is echoed: the client skips its own optimistic copy of the
      // first and adds steered ones where they reached the model. Same id as the
      // history item, so live and replayed turns line up.
      sess.lastUser = userPartId(ev.message.timestamp, sess.lastUser)
      sess.live.user = { partId: sess.lastUser.id, text: userText(ev.message.content) }
      broadcast(sess.id, { type: 'message.user', data: sess.live.user })
      return
    case 'message_end':
      if (ev.message.role === 'user') sess.live.user = undefined
      else if (ev.message.role === 'assistant') sess.live.assistant = undefined
      else if (ev.message.role === 'toolResult') sess.live.toolDone.delete(ev.message.toolCallId)
      return
    case 'queue_update':
      broadcast(sess.id, { type: 'session.queue', data: { messages: [...ev.steering, ...ev.followUp] } })
      return
    case 'message_update': {
      const e = ev.assistantMessageEvent
      if (e.type === 'text_delta') {
        const id = partId(e.partial, 't', e.contentIndex)
        liveBlock(sess, e.partial, id, 'message.delta', e.delta)
        broadcast(sess.id, { type: 'message.delta', data: { partId: id, text: e.delta } })
      } else if (e.type === 'thinking_start') {
        sess.thinkingStarts.set(partId(e.partial, 'k', e.contentIndex), Date.now())
      } else if (e.type === 'thinking_delta') {
        const id = partId(e.partial, 'k', e.contentIndex)
        liveBlock(sess, e.partial, id, 'message.thinking', e.delta)
        broadcast(sess.id, { type: 'message.thinking', data: { partId: id, text: e.delta } })
      } else if (e.type === 'thinking_end') {
        const id = partId(e.partial, 'k', e.contentIndex)
        const started = sess.thinkingStarts.get(id)
        if (started === undefined) return
        sess.thinkingStarts.delete(id)
        const data: ThinkingEntryData = { partId: id, durationMs: Date.now() - started }
        sess.manager.appendCustomEntry(THINKING_ENTRY, data)
        sess.live.assistant?.thinkingDone.push({ type: 'message.thinking.done', data })
        broadcast(sess.id, { type: 'message.thinking.done', data })
      }
      return
    }
    case 'tool_execution_start':
      broadcast(sess.id, { type: 'tool.start', data: { toolId: ev.toolCallId, tool: ev.toolName, input: JSON.stringify(ev.toolName === 'questionnaire' ? prepareQuestionnaireArguments(ev.args) : ev.args ?? {}) } })
      return
    case 'tool_execution_end': {
      const done: PlatformEvent = {
        type: 'tool.done',
        data: {
          toolId: ev.toolCallId, tool: ev.toolName,
          output: toolOutput(ev.result?.content), parsed: ev.isError ? undefined : ev.result?.details,
        },
      }
      sess.live.toolDone.set(ev.toolCallId, done)
      broadcast(sess.id, done)
      return
    }
    case 'turn_end':
    case 'compaction_end':
      broadcastUsage(sess)
      return
  }
}

async function openSession(id: string): Promise<Session | null> {
  if (!validId(id)) return null
  const cached = sessions.get(id)
  if (cached) return cached
  let data: SessionMetadata
  try {
    data = JSON.parse(await fs.readFile(transcriptPath(id), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (data.version !== 2) throw Object.assign(new Error('Legacy session format is unsupported; delete this session and create a new one'), { status: 409 })
  return newSession(id, data.model, NO_GATEWAY, data.titleAttempted)
}

// Takes effect from the next turn. The transcript carries over; pi-ai drops
// other models' thinking blocks and normalizes tool-call ids when replaying it.
async function switchModel(sess: Session, ref: ModelRef, gateway: Gateway): Promise<void> {
  sess.model = ref
  sess.gateway = gateway
  const model = resolveModel(ref, gateway.baseUrl)
  sess.runtime.registerProvider(ref.provider, { models: [model], baseUrl: gateway.baseUrl })
  await sess.runtime.setRuntimeApiKey(ref.provider, gateway.apiKey)
  await sess.sdk.setModel(model)
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

// Undelivered messages are dropped first so the run cannot continue with them;
// the client restores its own copy into the composer.
async function abortRun(sess: Session): Promise<void> {
  sess.sdk.clearQueue()
  sess.titleAbort?.abort()
  await sess.sdk.abort()
}

// Messages steered after the SDK's last delivery point, or while it was settling.
function takeQueued(sess: Session): string | undefined {
  const { steering, followUp } = sess.sdk.clearQueue()
  const texts = [...steering, ...followUp]
  return texts.length ? texts.join('\n\n') : undefined
}

async function runPrompt(sess: Session, text: string): Promise<void> {
  if (!sess.titled) {
    sess.titled = true
    const title = text.split('\n').find(l => l.trim())?.trim() ?? ''
    if (title) broadcast(sess.id, { type: 'session.title', data: { title: title.length > 60 ? title.slice(0, 57) + '…' : title } })
  }
  let next: string | undefined = text
  let titleSource: { text: string; reply: AssistantMessage } | undefined
  try {
    // Keep the run going while steered messages remain, so the stream stays open
    // until every message the user sent has been answered.
    while (next !== undefined) {
      const prompt: string = next
      try {
        await sess.sdk.prompt(prompt)
        const last = [...sess.sdk.messages].reverse().find(m => m.role === 'assistant') as AssistantMessage | undefined
        if (last?.stopReason === 'error') {
          broadcast(sess.id, { type: 'session.error', data: { message: last.errorMessage ?? 'model request failed' } })
        } else if (last?.stopReason === 'stop' && !sess.titleAttempted && !titleSource) {
          titleSource = { text: prompt, reply: last }
        }
      } catch (err) {
        console.error('[runPrompt]', err)
        broadcast(sess.id, { type: 'session.error', data: { message: err instanceof Error ? err.message : String(err) } })
      }
      next = takeQueued(sess)
      if (next === undefined && titleSource) {
        const { text: t, reply } = titleSource
        titleSource = undefined
        await generateTitle(sess, t, reply).catch(() => console.warn('[title] checkpoint failed for', sess.id))
        next = takeQueued(sess)
      }
      if (next === undefined && sessions.get(sess.id) === sess) {
        await persist(sess).catch(err => console.error('[persist]', err))
        next = takeQueued(sess)
      }
    }
  } finally {
    sess.busy = false
    sess.live = { toolDone: new Map() }
    broadcastUsage(sess)
    broadcast(sess.id, { type: 'session.idle', data: {} })
  }
}

// Steer texts into the running session. Steering resolves asynchronously, so the
// run may have ended meanwhile; then start a new run with what was queued.
async function steer(sess: Session, texts: string[]): Promise<'queued' | 'started'> {
  for (const text of texts) await sess.sdk.steer(text)
  if (sess.busy) return 'queued'
  const next = takeQueued(sess)
  if (next === undefined) return 'queued'
  sess.busy = true
  sess.run = runPrompt(sess, next)
  return 'started'
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

const app = express()
const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}
app.use(express.json({ limit: '10mb' }))

let stopping: Promise<void> | undefined
const sessionRequests = new Set<Promise<void>>()
const sessionRequestTails = new Map<string, Promise<void>>()
app.use((req, res, next) => {
  // Readiness and event streams remain available while sessions are released.
  if (!req.path.startsWith('/session') || (req.method === 'GET' && req.path === '/session')) return next()
  if (stopping) return void res.status(503).json({ error: 'agent is stopping' })
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  sessionRequests.add(pending)
  // SDK initialization is async. Serialize HTTP operations for each platform
  // session so concurrent register/history/delete calls cannot create two owners.
  const id = req.path.split('/')[2] ?? req.body?.id
  const previous = typeof id === 'string' ? sessionRequestTails.get(id) : undefined
  if (typeof id === 'string') sessionRequestTails.set(id, pending)
  const done = () => {
    sessionRequests.delete(pending)
    if (sessionRequestTails.get(id) === pending) sessionRequestTails.delete(id)
    complete()
  }
  res.once('finish', done)
  res.once('close', done)
  if (previous) void previous.then(() => { if (!res.destroyed) next() })
  else next()
})

app.post('/stop', asyncRoute(async (_req, res, next) => {
  stopping ??= (async () => {
    await Promise.all([...sessionRequests])
    const active = [...sessions.values()]
    for (const sess of active) void abortRun(sess)
    await Promise.allSettled(active.map(sess => sess.run))
    await Promise.all(active.map(sess => persist(sess)))
    for (const sess of active) sess.sdk.dispose()
    sessions.clear()
  })().finally(() => { stopping = undefined })
  try {
    await stopping
    res.status(204).end()
  } catch (err) { next(err) }
}))


app.get('/session', (_req, res) => {
  res.json([...sessions.keys()])
})

app.post('/session', asyncRoute(async (req, res) => {
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
    sess = await newSession(id, ref, gateway)
  } else {
    // Re-registering with a different model (or endpoint) switches it.
    const changed = existing.model.id !== ref.id || existing.model.provider !== ref.provider ||
      existing.gateway.baseUrl !== gateway.baseUrl
    if (changed) {
      if (existing.busy) return void res.status(409).json({ error: 'session is busy' })
      await switchModel(existing, ref, gateway)
    } else {
      existing.gateway = gateway
      await existing.runtime.setRuntimeApiKey(ref.provider, gateway.apiKey)
    }
    sess = existing
  }
  sess.smallModel = smallModel
  // The session's effort, applied from the next turn and clamped to the
  // levels the model supports (e.g. DeepSeek has no "medium").
  if (thinkingLevel) {
    sess.sdk.setThinkingLevel(thinkingLevel as ThinkingLevel)
  }
  if (!existing) await persist(sess)
  res.json({ id })
}))

app.get('/session/:id', asyncRoute(async (req, res) => {
  const sess = await openSession(req.params.id)
  if (!sess) return void res.status(404).json({ error: 'not found' })
  res.json({ id: sess.id, name: sess.manager.getSessionName() ?? '' })
}))

// Only accepted platform titles reach this endpoint. Do not rebroadcast here:
// automatic title proposals already travel through the backend's manual-name guard.
app.patch('/session/:id/name', asyncRoute(async (req, res) => {
  if (typeof req.body?.name !== 'string') return void res.status(400).json({ error: 'name is required' })
  const sess = await openSession(req.params.id)
  if (!sess) return void res.status(404).json({ error: 'not found' })
  const name = req.body.name.replace(/[\r\n]+/g, ' ').replace(/\u00b7/g, ' ').trim()
  if ((sess.manager.getSessionName() ?? '') !== name) sess.sdk.setSessionName(name)
  if (name) sess.titled = true
  res.json({ name: sess.manager.getSessionName() ?? '' })
}))

app.delete('/session/:id', asyncRoute(async (req, res) => {
  if (!validId(req.params.id)) return void res.status(400).end()
  const sess = sessions.get(req.params.id)
  if (!sess) {
    await fs.rm(transcriptPath(req.params.id), { force: true })
    await fs.rm(path.join(SESSIONS_DIR, `${req.params.id}.jsonl`), { force: true })
    return void res.status(204).end()
  }
  void abortRun(sess)
  sessions.delete(sess.id)
  await sess.run
  sess.sdk.dispose()
  await sess.persistQueue?.catch(() => {})
  await fs.rm(transcriptPath(sess.id), { force: true })
  await fs.rm(path.join(SESSIONS_DIR, `${sess.id}.jsonl`), { force: true })
  res.status(204).end()
}))

app.get('/session/:id/message', asyncRoute(async (req, res) => {
  const sess = await openSession(req.params.id)
  const items = sess ? history(sess) : []
  const current = sess ? usage(sess) : null
  items.push({ messageId: 'session-state', role: 'assistant', events: [
    { type: 'session.state', data: { busy: sess?.busy ?? false, seq: eventSeq } },
    { type: 'session.queue', data: { messages: sess ? queued(sess) : [] } },
    ...(current ? [current] : []),
  ] })
  res.json(items)
}))

app.post('/session/:id/prompt_async', asyncRoute(async (req, res) => {
  const sess = await openSession(req.params.id)
  if (!sess) return void res.status(404).end()
  const parts: Array<{ type: string; text: string }> = req.body?.parts ?? []
  const text = parts.find(p => p.type === 'text')?.text?.trim() ?? ''
  if (!text) return void res.status(400).end()
  if (!sess.gateway.apiKey) return void res.status(409).json({ error: 'session requires model registration' })
  if (sess.busy) {
    // Delivered after the current tool calls finish, before the next model request.
    return void res.status(await steer(sess, [text]) === 'queued' ? 202 : 204).end()
  }
  sess.busy = true
  res.status(204).end()
  sess.run = runPrompt(sess, text)
}))

// The SDK has no per-message removal: clear the queue and steer the rest again.
app.delete('/session/:id/queue/:index', asyncRoute(async (req, res) => {
  const sess = sessions.get(req.params.id)
  const index = Number(req.params.index)
  if (!sess || queued(sess)[index] !== req.body?.text) {
    return void res.status(409).json({ error: 'This message has already been sent' })
  }
  const { steering, followUp } = sess.sdk.clearQueue()
  const rest = [...steering, ...followUp].filter((_, i) => i !== index)
  await steer(sess, rest)
  res.json({ messages: queued(sess) })
}))

app.post('/session/:id/questionnaire/:toolId', asyncRoute(async (req, res) => {
  const sess = sessions.get(req.params.id)
  if (!sess) return void res.status(409).json({ error: 'This session is no longer waiting for answers' })
  sess.questionnaire.answer(req.params.toolId, req.body)
  res.status(204).end()
}))

app.post('/session/:id/abort', asyncRoute(async (req, res) => {
  const sess = await openSession(req.params.id)
  if (sess) await abortRun(sess)
  res.status(204).end()
}))

app.get('/event', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const send = (payload: string) => res.write(`data: ${payload}\n\n`)
  sseClients.add(send)
  // Viewers hold this open between runs; keep idle proxies from closing it.
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  req.on('close', () => {
    clearInterval(ping)
    sseClients.delete(send)
  })
})

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error('[http]', error)
  res.status(error.status ?? 500).json({ error: error.message ?? 'internal error' })
}
app.use(errorHandler)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pi-harness] listening on :${PORT}`)
})
