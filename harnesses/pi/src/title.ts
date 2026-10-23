import type { AssistantMessage } from '@earendil-works/pi-ai'

// Mirrors Codex's thread titles (codex-rs/tui/src/app/thread_title.rs): named
// from the first request alone, in JSON. Tasks get an imperative title like
// Codex; other messages (greetings, questions) get a noun phrase.
export const TITLE_MAX_CHARS = 36
const PROMPT_MAX_BYTES = 960

export const TITLE_PROMPT = `Generate a concise, single-line title of at most \
${TITLE_MAX_CHARS} characters and under five words where possible. \
For a task, start with an imperative verb. When the message is not a task \
(a greeting, small talk, or a general question), use a short noun phrase \
naming its topic instead, for example "Greeting" or "问候". Capitalize only the first word unless the \
user's language, proper nouns, acronyms, or code terms require otherwise. \
Preserve ticket references exactly. Write in the user's language. \
Do not use quotes, markdown, or trailing punctuation. \
Do not answer the request. \
Respond with only a JSON object of the form {"title": "..."}.`

// Structured output for the Responses API; other APIs rely on the prompt.
export const TITLE_FORMAT = {
  type: 'json_schema',
  name: 'thread_title',
  strict: true,
  schema: {
    type: 'object',
    properties: { title: { type: 'string', minLength: 1, maxLength: TITLE_MAX_CHARS } },
    required: ['title'],
    additionalProperties: false,
  },
}

// The whole request stays within PROMPT_MAX_BYTES without splitting a character.
export function titleInput(request: string): string {
  const prefix = 'User prompt:\n'
  let budget = PROMPT_MAX_BYTES - Buffer.byteLength(TITLE_PROMPT) - Buffer.byteLength(prefix)
  let out = ''
  for (const ch of request.trim()) {
    budget -= Buffer.byteLength(ch)
    if (budget < 0) break
    out += ch
  }
  return prefix + out
}

// These are recognisable conversational refusals/clarification requests, not
// a complete semantic classifier. Keep the fallback when the model emits them.
const NON_TITLE = /^(?:(?:抱歉|对不起)[，,：:\s]*)?(?:无法(?:确定|判断|生成|概括|总结)|不能(?:确定|判断)|(?:请|需要你?)(?:提供|补充|描述|告诉)|信息不足(?:[，,。.!！\s]|$)|缺少(?:足够|具体)|对话(?:内容|信息)不足)|^(?:(?:sorry[,!:.]?\s*)?(?:i\s+(?:cannot|can't|need|am unable)|unable to|cannot (?:determine|generate|summari[sz]e)|please (?:provide|share|specify|clarify)|(?:not enough|insufficient) (?:information|context)))/iu

export function parseTitle(result: Pick<AssistantMessage, 'stopReason' | 'content'>): string | undefined {
  if (result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall')) return
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  if (!text.startsWith('{')) return
  let title: unknown
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (Object.keys(parsed).length !== 1) return
    title = parsed.title
  } catch { return }
  if (typeof title !== 'string') return
  const normalized = title
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/·/gu, ' ')
    .split(/\s+/u).filter(Boolean).join(' ')
    .replace(/[.?!。？！]+$/u, '')
    .trim()
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized) || NON_TITLE.test(normalized)) return
  return Array.from(normalized).slice(0, TITLE_MAX_CHARS).join('').trimEnd()
}
