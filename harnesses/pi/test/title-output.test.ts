import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTitle, titleInput, TITLE_PROMPT } from '../src/title.ts'

const title = (text: string) => parseTitle({ stopReason: 'stop', content: [{ type: 'text', text }] })
const json = (t: string) => JSON.stringify({ title: t })

test('reads the JSON title and normalizes it', () => {
  assert.equal(title(json('修复登录问题')), '修复登录问题')
  assert.equal(title(json('  "Fix login   bug."  ')), 'Fix login bug')
  assert.equal(title(json('Fix PROJ-123 crash?!')), 'Fix PROJ-123 crash')
  assert.equal(title(json('修复“请提供密码”提示')), '修复“请提供密码”提示')
  assert.equal(Array.from(title(json('猫'.repeat(70)))!).length, 36)
  assert.equal(title(json('Investigate PROJ-482 CI integration timeouts')), 'Investigate PROJ-482 CI integration')
})

test('rejects refusals and anything but a single-key JSON title', () => {
  for (const text of [
    json('无法确定对话主题，请提供具体任务。'), json('抱歉，无法判断主题。'), json('Please provide a specific task.'),
    json(''), json('**'), JSON.stringify({ title: 'Fix', extra: 1 }), JSON.stringify({ name: 'Fix' }),
    'Fix login bug', '```json\n{"title":"Fix login"}\n```', '{"title": "Fix', '',
  ]) assert.equal(title(text), undefined, text)
  assert.equal(parseTitle({ stopReason: 'length', content: [{ type: 'text', text: json('Partial') }] }), undefined)
  assert.equal(parseTitle({ stopReason: 'stop', content: [{ type: 'text', text: json('Fix') }, { type: 'toolCall', id: '1', name: 'tool', arguments: {} }] }), undefined)
})

test('bounds the request without splitting characters', () => {
  const input = titleInput('修'.repeat(1000))
  assert.ok(Buffer.byteLength(TITLE_PROMPT) + Buffer.byteLength(input) <= 960)
  assert.ok(!input.includes('\uFFFD'))
  assert.equal(titleInput('  Fix login  '), 'User prompt:\nFix login')
})
