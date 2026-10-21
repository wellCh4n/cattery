import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTitle } from '../src/title.ts'

const title = (text: string) => parseTitle({ stopReason: 'stop', content: [{ type: 'text', text }] })

test('uses the first nonempty line and cleans title formatting', () => {
  assert.equal(title('\n **修复登录问题**\n这是一个简短标题。'), '修复登录问题')
  assert.equal(title('Title: "Fix login bug"'), 'Fix login bug')
  assert.equal(title('问候交流'), '问候交流')
  assert.equal(title('任务讨论'), '任务讨论')
  assert.equal(title('信息不足错误处理'), '信息不足错误处理')
  assert.equal(title('修复“请提供密码”提示'), '修复“请提供密码”提示')
  assert.equal(Array.from(title('猫'.repeat(70))!).length, 60)
})

test('rejects clarification replies and malformed output', () => {
  for (const text of [
    '无法确定对话主题，请提供具体任务。',
    '抱歉，无法判断主题。', '请提供具体任务。',
    'I cannot determine the topic. Please provide more context.',
    'Please provide a specific task.', 'Insufficient context to generate a title.',
    '', '**', '```json\n{"title":"Fix login"}\n```', '<title>Fix login</title>',
  ]) assert.equal(title(text), undefined, text)
  assert.equal(parseTitle({ stopReason: 'length', content: [{ type: 'text', text: 'Partial' }] }), undefined)
  assert.equal(parseTitle({ stopReason: 'stop', content: [{ type: 'text', text: 'Fix login' }, { type: 'toolCall', id: '1', name: 'tool', arguments: {} }] }), undefined)
})
