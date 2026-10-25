import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Usage } from '@earendil-works/pi-ai'
import { UsageLedger } from '../src/usage.ts'

const usage = (input: number, output = 0): Usage => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

async function ledgerFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-'))
  return path.join(dir, 'nested/usage.jsonl')
}

test('reads appended records from an offset', async () => {
  const ledger = new UsageLedger(await ledgerFile())
  assert.deepEqual(await ledger.read(0), { records: [], offset: 0, more: false })
  ledger.record('s1', 'reply', 'm', usage(10, 5))
  ledger.record('s1', 'title', 'small', usage(3))
  ledger.record('s1', 'reply', 'm', usage(0))
  const first = await ledger.read(0)
  assert.deepEqual(first.records.map(r => [r.kind, r.input, r.output]), [['reply', 10, 5], ['title', 3, 0]])
  assert.equal(first.more, false)
  ledger.record('s2', 'compaction', 'm', usage(7))
  const next = await ledger.read(first.offset)
  assert.deepEqual(next.records.map(r => [r.sessionId, r.kind]), [['s2', 'compaction']])
})

test('restarts from 0 when the offset does not fit the ledger', async () => {
  const file = await ledgerFile()
  const ledger = new UsageLedger(file)
  ledger.record('s1', 'reply', 'm', usage(1))
  ledger.record('s1', 'reply', 'm', usage(2))
  const all = await ledger.read(0)
  assert.equal((await ledger.read(all.offset + 100)).records.length, 2)
  assert.equal((await ledger.read(3)).records.length, 2)
})

test('leaves a torn last line for the next read', async () => {
  const file = await ledgerFile()
  const ledger = new UsageLedger(file)
  ledger.record('s1', 'reply', 'm', usage(1))
  const { offset } = await ledger.read(0)
  await fs.appendFile(file, '{"id":"x"')
  const torn = await ledger.read(offset)
  assert.deepEqual(torn, { records: [], offset, more: false })
})
