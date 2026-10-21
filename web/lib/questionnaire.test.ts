import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { useChatStreamStore } from "./chat-stream-store"
import { answerQuestionnaire } from "./api"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; useChatStreamStore.setState({ sessions: {} }) })
const tool = { type: "tool.start", data: { toolId: "q", tool: "questionnaire", input: '{"questions":[]}' } }
const history = (busy: boolean, answered = false) => [{ messageId: "turn", role: "assistant", events: [
  tool,
  ...(answered ? [{ type: "tool.done", data: { toolId: "q", tool: "questionnaire", output: "Chosen", parsed: { answers: [{ id: "scope", label: "Small" }], cancelled: false } } }] : []),
  { type: "session.state", data: { busy } },
] }]

test("refresh restores pending questionnaire and follows run until answer is persisted", async () => {
  let busy = true
  globalThis.fetch = (async () => Response.json(history(busy, !busy))) as typeof fetch
  await useChatStreamStore.getState().loadHistory("s")
  let session = useChatStreamStore.getState().sessions.s
  assert.equal(session.recovering, true)
  assert.equal(session.bubbles[0].done, false)
  assert.equal(session.bubbles[0].toolName, "questionnaire")
  busy = false
  await useChatStreamStore.getState().loadHistory("s", true)
  session = useChatStreamStore.getState().sessions.s
  assert.equal(session.recovering, false)
  assert.equal(session.bubbles[0].done, true)
  assert.equal(session.bubbles[0].toolOutput, "Chosen")
})

test("an interrupted questionnaire is closed when its agent is no longer running", async () => {
  globalThis.fetch = (async () => Response.json(history(false))) as typeof fetch
  await useChatStreamStore.getState().loadHistory("s")
  assert.equal(useChatStreamStore.getState().sessions.s.bubbles[0].done, true)
})

test("answer endpoint encodes tool ids and propagates stale submission errors", async () => {
  globalThis.fetch = (async (url, init) => {
    assert.ok(String(url).endsWith('/sessions/s/questionnaire/call%2F1'))
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { answers: [], cancelled: true })
    return Response.json({ message: 'Already answered' }, { status: 409 })
  }) as typeof fetch
  await assert.rejects(answerQuestionnaire('s', 'call/1', { answers: [], cancelled: true }), /Already answered/)
})
