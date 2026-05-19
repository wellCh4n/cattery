/**
 * Codex Responses-API ⇄ Chat-Completions translator.
 *
 * Codex CLI removed Chat Completions support
 * (github.com/openai/codex/discussions/7782) — its model_provider must speak
 * OpenAI's Responses API (/v1/responses). Most third-party OpenAI-compatible
 * gateways (NewAPI, OneAPI, dsdigital…) only expose /v1/chat/completions.
 * This shim runs inside the codex harness container, accepts Responses API
 * requests from the local codex process, and forwards them upstream as Chat
 * Completions, then translates the streamed response back.
 *
 * Listens on 127.0.0.1 only — never exposed outside the pod.
 *
 *  codex ──POST /v1/responses──► shim ──POST /chat/completions──► gateway
 *        ◄── responses-API SSE ── shim ◄── chat-completions SSE ── gateway
 *
 * Scope: text streaming + parallel tool calls + tool-result echo-back. That
 * covers a normal codex coding session. Skipped: reasoning streams,
 * structured-output JSON schema enforcement, the WebSocket transport (codex
 * falls back to HTTP). Add as needed.
 */

import express, { Request, Response } from 'express'

// ── types (just enough to be useful) ─────────────────────────────────────────

interface InputContentPart {
  type: string
  text?: string
}

interface InputItem {
  type?: string                    // "message" | "function_call" | "function_call_output" | "reasoning"
  role?: string                    // for messages
  content?: InputContentPart[] | string
  // function_call
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  // function_call_output
  output?: string
}

interface Tool {
  type?: string                    // usually "function"
  name?: string                    // top-level on Responses tool shape
  description?: string
  parameters?: unknown
  strict?: boolean
  function?: { name: string; description?: string; parameters?: unknown; strict?: boolean }
}

interface ResponsesRequest {
  model: string
  input?: InputItem[]
  instructions?: string
  tools?: Tool[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  stream?: boolean
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

// ── request translation: Responses → Chat ───────────────────────────────────

function toolsToChat(tools?: Tool[]): unknown {
  if (!tools) return undefined
  return tools.map(t => {
    // Responses shape: { type: "function", name, description, parameters }
    // Chat shape:      { type: "function", function: { name, description, parameters } }
    if (t.function) return t                                // already chat-shaped
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: t.strict,
      },
    }
  })
}

function partsToText(content: InputContentPart[] | string | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter(p => typeof p.text === 'string' && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text' || p.type?.endsWith('_text')))
    .map(p => p.text ?? '')
    .join('')
}

/**
 * Walk the Responses-format input array and emit Chat-Completions messages.
 *
 * Key transformations:
 *   - Consecutive `function_call` items from the assistant collapse into a
 *     SINGLE assistant message with `tool_calls: [...]`. Chat semantics
 *     require this — each tool call must belong to a preceding assistant
 *     message, not be its own top-level item.
 *   - `function_call_output` becomes a `role: "tool"` message with
 *     `tool_call_id`.
 *   - `reasoning` items are dropped (Chat Completions has no equivalent).
 */
function inputToChatMessages(input: InputItem[] | undefined, instructions?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (instructions) messages.push({ role: 'system', content: instructions })
  if (!input) return messages

  let pendingAssistantCalls: NonNullable<ChatMessage['tool_calls']> | null = null
  const flushPendingCalls = () => {
    if (pendingAssistantCalls && pendingAssistantCalls.length) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingAssistantCalls })
    }
    pendingAssistantCalls = null
  }

  for (const item of input) {
    const t = item.type
    if (t === 'function_call') {
      pendingAssistantCalls ??= []
      pendingAssistantCalls.push({
        id: item.call_id || item.id || '',
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '' },
      })
      continue
    }
    flushPendingCalls()

    if (t === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: item.output ?? '' })
      continue
    }
    if (t === 'reasoning') continue        // chat has no reasoning channel

    // message (or untyped item with a role)
    const role = (item.role || 'user') as ChatMessage['role']
    messages.push({ role, content: partsToText(item.content) })
  }
  flushPendingCalls()
  return messages
}

// ── response translation: Chat Completions SSE → Responses SSE ──────────────

interface ChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function writeEvent(res: Response, name: string, payload: object): void {
  res.write(`event: ${name}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function streamTranslate(
  upstream: globalThis.Response,
  res: Response,
  model: string,
): Promise<void> {
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let seq = 0
  const responseId = `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  // Output-item tracking. Each item in the Responses output array gets a
  // sequential index; codex matches deltas back via item_id.
  let outIndex = 0
  let textItemId: string | null = null
  let textBuffer = ''
  // tool calls indexed by their Chat-Completions delta index
  const tools = new Map<number, { itemId: string; callId: string; name: string; args: string }>()
  let finished = false
  let finalFinishReason: string | null = null
  let usage: ChatStreamChunk['usage'] = undefined

  writeEvent(res, 'response.created', {
    type: 'response.created',
    sequence_number: seq++,
    response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] },
  })

  const closeOutputs = () => {
    if (textItemId !== null) {
      writeEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: seq++,
        item: {
          id: textItemId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textBuffer }],
        },
      })
    }
    for (const entry of tools.values()) {
      writeEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: seq++,
        item: {
          id: entry.itemId,
          type: 'function_call',
          call_id: entry.callId,
          name: entry.name,
          arguments: entry.args,
        },
      })
    }
  }

  const completeWith = (status: 'completed' | 'failed', errorMessage?: string) => {
    if (finished) return
    finished = true
    closeOutputs()
    const endTurn = finalFinishReason === 'stop' || finalFinishReason === 'tool_calls' || finalFinishReason === 'length'
    writeEvent(res, status === 'failed' ? 'response.failed' : 'response.completed', {
      type: status === 'failed' ? 'response.failed' : 'response.completed',
      sequence_number: seq++,
      response: {
        id: responseId,
        object: 'response',
        status,
        end_turn: endTurn,
        usage: usage ? {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        } : undefined,
        error: errorMessage ? { code: 'upstream_error', message: errorMessage } : undefined,
      },
    })
    res.end()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE events are \n\n-delimited blocks; each block has `data: ...` lines.
      let nl
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let chunk: ChatStreamChunk
          try { chunk = JSON.parse(data) } catch { continue }

          if (chunk.usage) usage = chunk.usage
          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}

          // ── text content ────────────────────────────────────────────────
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (textItemId === null) {
              textItemId = `msg_${responseId}_${outIndex}`
              writeEvent(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                sequence_number: seq++,
                output_index: outIndex++,
                item: { id: textItemId, type: 'message', role: 'assistant', content: [] },
              })
            }
            textBuffer += delta.content
            writeEvent(res, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              sequence_number: seq++,
              item_id: textItemId,
              output_index: outIndex - 1,
              delta: delta.content,
            })
          }

          // ── tool calls ──────────────────────────────────────────────────
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              let entry = tools.get(idx)
              if (!entry) {
                const itemId = `fc_${responseId}_${outIndex}`
                entry = {
                  itemId,
                  callId: tc.id || itemId,
                  name: tc.function?.name || '',
                  args: '',
                }
                tools.set(idx, entry)
                writeEvent(res, 'response.output_item.added', {
                  type: 'response.output_item.added',
                  sequence_number: seq++,
                  output_index: outIndex++,
                  item: {
                    id: entry.itemId,
                    type: 'function_call',
                    call_id: entry.callId,
                    name: entry.name,
                    arguments: '',
                  },
                })
              } else {
                if (tc.id && !entry.callId) entry.callId = tc.id
                if (tc.function?.name && !entry.name) entry.name = tc.function.name
              }
              const argDelta = tc.function?.arguments
              if (argDelta) {
                entry.args += argDelta
                writeEvent(res, 'response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  sequence_number: seq++,
                  item_id: entry.itemId,
                  call_id: entry.callId,
                  delta: argDelta,
                })
              }
            }
          }

          if (choice.finish_reason) finalFinishReason = choice.finish_reason
        }
      }
    }
    completeWith('completed')
  } catch (err) {
    completeWith('failed', err instanceof Error ? err.message : String(err))
  }
}

// ── express handler ─────────────────────────────────────────────────────────

export function mountResponsesShim(app: express.Express, upstreamBase: string, apiKey: string): void {
  // The base url codex was configured with may or may not include /v1. The
  // shim accepts both routes so it doesn't matter which one ends up in
  // config.toml.
  const handler = async (req: Request, res: Response) => {
    const body = req.body as ResponsesRequest
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: { message: 'invalid request body' } })
      return
    }

    const chatReq = {
      model: body.model,
      messages: inputToChatMessages(body.input, body.instructions),
      tools: toolsToChat(body.tools),
      tool_choice: body.tool_choice,
      parallel_tool_calls: body.parallel_tool_calls,
      stream: true,
      stream_options: { include_usage: true },
    }

    const target = `${upstreamBase.replace(/\/+$/, '')}/chat/completions`
    let upstream: globalThis.Response
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(chatReq),
      })
    } catch (err) {
      console.error('[shim] upstream fetch failed:', err instanceof Error ? err.message : err)
      res.status(502).json({ error: { message: 'upstream fetch failed' } })
      return
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '<unreadable>')
      console.error(`[shim] upstream ${upstream.status}: ${text.slice(0, 500)}`)
      res.status(upstream.status).type('application/json').send(text)
      return
    }

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    await streamTranslate(upstream, res, body.model)
  }

  app.post('/v1/responses', handler)
  app.post('/responses',    handler)        // when base_url already has /v1
}
