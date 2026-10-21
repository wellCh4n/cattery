"use client"

import { useState } from "react"
import { MessageCircleQuestionIcon, CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { answerQuestionnaire } from "@/lib/api"
import { type Bubble, useChatStreamStore } from "@/lib/chat-stream-store"

interface Question {
  id: string
  label?: string
  prompt: string
  options: Array<{ value: string; label: string; description?: string }>
  allowOther?: boolean
}
interface Answer { id: string; value: string; wasCustom: boolean }
interface Result { answers?: Array<Answer & { label: string }>; cancelled?: boolean }

function parseQuestions(raw: string): Question[] {
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data.questions)) return []
    return data.questions.filter((q: Question) => q && typeof q.id === "string" && typeof q.prompt === "string" && Array.isArray(q.options) && q.options.every(o => o && typeof o.value === "string" && typeof o.label === "string"))
  } catch { return [] }
}

export function QuestionnaireCard({ bubble, sessionId }: { bubble: Bubble; sessionId: string }) {
  const questions = parseQuestions(bubble.content)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [page, setPage] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState<Result | null>(null)
  const [error, setError] = useState("")
  const result = (bubble.toolParsed as Result | undefined) ?? submitted
  const closed = bubble.done || submitted
  const q = questions[page]
  const review = !q
  const complete = questions.length > 0 && questions.every(q => answers[q.id] && (!answers[q.id].wasCustom || answers[q.id].value.trim()))
  const label = (q: Question, i: number) => q.label || `Q${i + 1}`
  const setAnswer = (q: Question, value: string, wasCustom: boolean) => setAnswers(prev => ({ ...prev, [q.id]: { id: q.id, value, wasCustom } }))

  async function submit(cancelled: boolean) {
    if (submitting || closed) return
    setSubmitting(true)
    setError("")
    try {
      await answerQuestionnaire(sessionId, bubble.id, { cancelled, answers: cancelled ? [] : questions.map(q => answers[q.id]) })
      setSubmitted({ cancelled, answers: cancelled ? [] : questions.map(q => ({
        ...answers[q.id], label: answers[q.id].wasCustom ? answers[q.id].value.trim() : q.options.find(o => o.value === answers[q.id].value)!.label,
      })) })
      // A restored session follows the run through history snapshots.
      if (!useChatStreamStore.getState().sessions[sessionId]?.sending) {
        await useChatStreamStore.getState().loadHistory(sessionId, true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit answers")
    } finally { setSubmitting(false) }
  }

  if (!questions.length) return <p className="text-sm text-muted-foreground">{bubble.toolOutput || "Invalid questionnaire"}</p>

  return (
    <section aria-label="Questionnaire" className="w-full rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium">
        {closed ? <CheckIcon className="size-4" /> : <MessageCircleQuestionIcon className="size-4" />}
        {closed ? (result?.cancelled ? "Questionnaire cancelled" : result?.answers ? "Answers submitted" : submitted ? "Response submitted" : "Questionnaire ended") : "Waiting for your answer"}
        {!closed && <span className="ml-auto text-xs text-muted-foreground">{Object.keys(answers).filter(id => answers[id].value.trim()).length} / {questions.length}</span>}
      </div>
      {closed ? (
        <div className="space-y-3 text-sm">
          {questions.map((q, i) => {
            const answer = result?.answers?.find(a => a.id === q.id)
            return <div key={q.id}><p className="font-medium">{label(q, i)}: {q.prompt}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{answer?.label || "No answer recorded"}</p></div>
          })}
          {!result && bubble.toolOutput && <p className="text-muted-foreground">{bubble.toolOutput}</p>}
        </div>
      ) : (
        <form onSubmit={e => { e.preventDefault(); if (complete && (questions.length === 1 || review)) void submit(false) }}>
          {questions.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-1" aria-label="Questions">
              {questions.map((q, i) => <Button key={q.id} type="button" size="sm" variant={page === i ? "secondary" : "ghost"} onClick={() => setPage(i)} aria-current={page === i ? "step" : undefined}>{answers[q.id]?.value.trim() && <CheckIcon className="size-3" />}{label(q, i)}</Button>)}
              <Button type="button" size="sm" variant={review ? "secondary" : "ghost"} onClick={() => setPage(questions.length)}>Review</Button>
            </div>
          )}
          {q ? (
            <fieldset disabled={submitting} className="space-y-2">
              <legend className="mb-3 whitespace-pre-wrap text-sm font-medium">{q.prompt}</legend>
              {q.options.map((option, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-primary/5">
                  <input type="radio" name={`${bubble.id}-${q.id}`} className="mt-1 accent-primary" checked={answers[q.id]?.wasCustom === false && answers[q.id]?.value === option.value} onChange={() => setAnswer(q, option.value, false)} />
                  <span className="min-w-0 break-words"><span className="font-medium">{option.label}</span>{option.description && <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>}</span>
                </label>
              ))}
              {q.allowOther !== false && (
                <label className="block rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-primary/5">
                  <span className="flex items-center gap-3"><input type="radio" name={`${bubble.id}-${q.id}`} className="accent-primary" checked={answers[q.id]?.wasCustom === true} onChange={() => setAnswer(q, "", true)} />Write your own answer</span>
                  {answers[q.id]?.wasCustom && <textarea aria-label={`Your answer to ${q.prompt}`} className="mt-3 min-h-20 w-full rounded-lg border bg-background p-2 outline-none focus:ring-2 focus:ring-ring" value={answers[q.id].value} onChange={e => setAnswer(q, e.target.value, true)} />}
                </label>
              )}
            </fieldset>
          ) : (
            <div className="space-y-3 text-sm">{questions.map((q, i) => <div key={q.id}><p className="font-medium">{label(q, i)}: {q.prompt}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{answers[q.id]?.wasCustom ? answers[q.id].value : q.options.find(o => o.value === answers[q.id]?.value)?.label || "Not answered"}</p></div>)}</div>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => void submit(true)}>Cancel</Button>
            <div className="ml-auto flex gap-2">
              {page > 0 && <Button type="button" variant="outline" size="sm" onClick={() => setPage(page - 1)}>Back</Button>}
              {questions.length > 1 && !review ? <Button key="next" type="button" size="sm" onClick={e => { e.preventDefault(); setPage(page + 1) }}>Next</Button> : <Button key="submit" type="submit" size="sm" disabled={!complete || submitting}>{submitting ? "Submitting…" : "Submit answers"}</Button>}
            </div>
          </div>
        </form>
      )}
    </section>
  )
}
