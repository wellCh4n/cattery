import { Type, type Static } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

// Same parameter and result shapes as pi's examples/extensions/questionnaire.ts.
const Params = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String({ description: 'Unique identifier for this question' }),
    label: Type.Optional(Type.String({ description: 'Short contextual label (defaults to Q1, Q2)' })),
    prompt: Type.String({ description: 'The full question text to display' }),
    options: Type.Array(Type.Object({
      value: Type.String({ description: 'The value returned when selected' }),
      label: Type.String({ description: 'Display label for the option' }),
      description: Type.Optional(Type.String()),
    })),
    allowOther: Type.Optional(Type.Boolean({ description: 'Allow a custom answer (default: true)' })),
  })),
})
type Question = Static<typeof Params>['questions'][number]
interface Answer { id: string; value: string; label: string; wasCustom: boolean; index?: number }
interface Result { questions: Question[]; answers: Answer[]; cancelled: boolean }
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }) }

// pi runs this hook before schema validation. Keep explicit values untouched;
// tolerate models that emit display labels without the corresponding values.
export function prepareQuestionnaireArguments(input: unknown): Static<typeof Params> {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!record(input) || !Array.isArray(input.questions)) return input as Static<typeof Params>
  return { ...input, questions: input.questions.map(question => {
    if (!record(question) || !Array.isArray(question.options)) return question
    const used = new Set(question.options.filter(record).map(o => o.value).filter(v => typeof v === 'string'))
    return { ...question, options: question.options.map(option => {
      if (!record(option) || option.value !== undefined || typeof option.label !== 'string') return option
      let value = option.label
      let suffix = 2
      while (used.has(value)) value = `${option.label}_${suffix++}`
      used.add(value)
      return { ...option, value }
    }) }
  }) } as Static<typeof Params>
}

export class Questionnaire {
  private pending = new Map<string, { questions: Question[]; resolve: (result: Result) => void }>()

  answer(toolId: string, input: unknown): void {
    const pending = this.pending.get(toolId)
    if (!pending) return fail(409, 'This questionnaire is no longer waiting for an answer')
    const body = input as { cancelled?: unknown; answers?: unknown }
    if (!body || typeof body !== 'object') return fail(400, 'Invalid questionnaire response')
    if (body.cancelled === true) {
      pending.resolve({ questions: pending.questions, answers: [], cancelled: true })
      return
    }
    if (!Array.isArray(body.answers) || body.answers.length !== pending.questions.length) return fail(400, 'Answer every question')
    const raw = body.answers as Array<{ id?: unknown; value?: unknown; wasCustom?: unknown }>
    const answers: Answer[] = pending.questions.map(q => {
      const matches = raw.filter(a => a && a.id === q.id)
      if (matches.length !== 1) return fail(400, 'Each question needs exactly one answer')
      const a = matches[0]
      if (typeof a.value !== 'string' || typeof a.wasCustom !== 'boolean') return fail(400, 'Invalid answer')
      if (a.wasCustom) {
        if (q.allowOther === false || !a.value.trim()) return fail(400, 'Custom answer is not allowed or is empty')
        return { id: q.id, value: a.value.trim(), label: a.value.trim(), wasCustom: true }
      }
      const index = q.options.findIndex(o => o.value === a.value)
      if (index < 0) return fail(400, 'Unknown option')
      return { id: q.id, value: q.options[index].value, label: q.options[index].label, wasCustom: false, index: index + 1 }
    })
    pending.resolve({ questions: pending.questions, answers, cancelled: false })
  }

  readonly tool = {
    name: 'questionnaire',
    label: 'Questionnaire',
    description: 'Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.',
    parameters: Params,
    prepareArguments: prepareQuestionnaireArguments,
    execute: async (toolId, params, signal) => {
      const questions = params.questions.map((q, i) => ({ ...q, label: q.label || `Q${i + 1}`, allowOther: q.allowOther !== false }))
      if (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length || questions.some(q => !q.id || (!q.options.length && !q.allowOther) || new Set(q.options.map(o => o.value)).size !== q.options.length)) {
        throw new Error('Questions must have unique ids and answerable, unique options')
      }
      const result = await new Promise<Result>(resolve => {
        const finish = (result: Result) => {
          this.pending.delete(toolId)
          signal?.removeEventListener('abort', abort)
          resolve(result)
        }
        const abort = () => finish({ questions, answers: [], cancelled: true })
        this.pending.set(toolId, { questions, resolve: finish })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      const text = result.cancelled ? 'User cancelled the questionnaire' : result.answers.map(a => {
        const label = questions.find(q => q.id === a.id)?.label || a.id
        return a.wasCustom ? `${label}: user wrote: ${a.label}` : `${label}: user selected: ${a.index}. ${a.label}`
      }).join('\n')
      return { content: [{ type: 'text', text }], details: result }
    },
  } satisfies ToolDefinition<typeof Params, Result>
}
