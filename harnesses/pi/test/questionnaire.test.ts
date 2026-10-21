import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Questionnaire } from '../src/questionnaire.ts'

const questions = [{ id: 'q', prompt: 'Choose', options: [{ value: 'a', label: 'A' }], allowOther: false }]
const execute = (q: Questionnaire, signal?: AbortSignal, params = questions) => q.tool.execute('call', { questions: params }, signal)

test('rejects invalid answers without resolving, derives trusted labels, and rejects duplicate submission', async () => {
  const q = new Questionnaire()
  const pending = execute(q)
  for (const body of [null, { answers: [] }, { answers: [{ id: 'q', value: 'bad', wasCustom: false }] }, { answers: [{ id: 'q', value: 'custom', wasCustom: true }] }]) {
    assert.throws(() => q.answer('call', body), { status: 400 })
  }
  q.answer('call', { answers: [{ id: 'q', value: 'a', label: 'forged', wasCustom: false }] })
  const result = await pending
  assert.deepEqual(result.details.answers, [{ id: 'q', value: 'a', label: 'A', wasCustom: false, index: 1 }])
  assert.throws(() => q.answer('call', { cancelled: true }), { status: 409 })
})

test('abort releases waiters and cancellation returns the example result shape', async () => {
  for (const alreadyAborted of [false, true]) {
    const q = new Questionnaire()
    const ctrl = new AbortController()
    if (alreadyAborted) ctrl.abort()
    const pending = execute(q, ctrl.signal)
    ctrl.abort()
    assert.equal((await pending).details.cancelled, true)
    assert.throws(() => q.answer('call', { cancelled: true }), { status: 409 })
  }
  const q = new Questionnaire()
  const pending = execute(q)
  q.answer('call', { cancelled: true })
  assert.equal((await pending).content[0].text, 'User cancelled the questionnaire')
})

test('rejects unanswerable or ambiguous questions before waiting', async () => {
  for (const params of [[], [questions[0], questions[0]], [{ ...questions[0], options: [] }]]) {
    await assert.rejects(execute(new Questionnaire(), undefined, params))
  }
})

test('prepares missing option values without changing explicit values or the model input', async () => {
  const q = new Questionnaire()
  const input = { questions: [{ id: 'idea', prompt: 'What project?', options: [
    { label: 'HTTP API 服务（FastAPI）', description: 'CRUD + SQLite' },
    { label: 'CLI' }, { label: 'CLI' }, { label: 'Explicit', value: 'CLI' },
  ] }] }
  const params = q.tool.prepareArguments(input)
  assert.deepEqual(params.questions[0].options.map(o => o.value), ['HTTP API 服务（FastAPI）', 'CLI_2', 'CLI_3', 'CLI'])
  assert.equal('value' in input.questions[0].options[0], false)
  assert.deepEqual(q.tool.prepareArguments(params), params)
  const pending = q.tool.execute('call', params, undefined)
  q.answer('call', { answers: [{ id: 'idea', value: 'HTTP API 服务（FastAPI）', wasCustom: false }] })
  assert.equal((await pending).details.answers[0].index, 1)
})
