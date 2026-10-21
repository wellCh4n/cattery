import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFindTool, createGrepTool, createBashTool } from '@earendil-works/pi-coding-agent'

// Production image installs both binaries. Local development can run the other
// SDK tests without them; a present but incompatible fd must fail this test.
const hasSearchTools = ['fd', 'rg'].every(bin => spawnSync(bin, ['--version']).status === 0)
test('official find/grep and bash work with production container dependencies', { skip: !hasSearchTools }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'cattery-search-'))
  const tools = [createFindTool(cwd), createGrepTool(cwd), createBashTool(cwd)]
  const run = (name: string, args: any) => tools.find(t => t.name === name)!.execute('test', args)
  try {
    await writeFile(path.join(cwd, 'example.txt'), 'search sentinel')
    await writeFile(path.join(cwd, 'ignored.txt'), 'search sentinel')
    await writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n')
    const found = await run('find', { pattern: '*.txt' })
    assert.deepEqual(found.content, [{ type: 'text', text: 'example.txt' }])
    const empty = await run('find', { pattern: '*.missing' })
    assert.deepEqual(empty.content, [{ type: 'text', text: 'No files found matching pattern' }])
    const grep = await run('grep', { pattern: 'sentinel' })
    assert.ok(grep.content.some((c: any) => c.type === 'text' && c.text.includes('example.txt:1:')))
    const bash = await run('bash', { command: 'printf shell-ok' })
    assert.ok(bash.content.some((c: any) => c.type === 'text' && c.text.includes('shell-ok')))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
