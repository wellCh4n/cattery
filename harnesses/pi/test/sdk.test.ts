import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

// Exercise the real Agent + pi-ai HTTP path with a local model provider.
test('SDK preserves protocol, resources, tools, history, isolated gateways, titles, and stop/restart', { timeout: 60000 }, async () => {
  const requests: any[] = []
  let mode = 'success'
  let transientFailures = 0
  const provider = createServer(async (req, res) => {
    let data = ''
    for await (const chunk of req) data += chunk
    const body = JSON.parse(data)
    requests.push({ ...body, auth: req.headers.authorization })
    const title = body.model === 'small'
    if (!title && mode === 'transient' && transientFailures++ === 0) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' })
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }))
      return
    }
    if (!title && mode === 'hang') return
    if ((title && mode === 'title-error') || (!title && mode === 'main-error')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'test failure', type: 'invalid_request_error' } }))
      return
    }
    if (title && mode === 'timeout') return // Client aborts the title request after 15 seconds.
    if (!title && mode === 'tools' && body.messages.at(-1)?.role !== 'tool') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'read-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'example.txt', offset: 2, limit: 1 }) } }] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    const text = title ? (mode === 'empty' ? '' : mode === 'clarification' ? '无法确定对话主题，请提供具体任务。' : '修复登录问题') : 'Login fixed.'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const choice of [
      { delta: { role: 'assistant', content: text }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]) res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const baseUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1`
  const portServer = createServer()
  portServer.listen(0, '127.0.0.1')
  await once(portServer, 'listening')
  const port = (portServer.address() as any).port
  await new Promise<void>(resolve => portServer.close(() => resolve()))
  const dir = await mkdtemp(path.join(tmpdir(), 'cattery-title-'))
  await writeFile(path.join(dir, 'AGENTS.md'), 'Cattery SDK context sentinel')
  await writeFile(path.join(dir, 'example.txt'), 'one\ntwo\nthree')
  await mkdir(path.join(dir, 'skill-fixture'))
  await writeFile(path.join(dir, 'skill-fixture/SKILL.md'), '---\nname: skill-fixture\ndescription: >\n  Multiline skill\n  description sentinel\n---\nSkill body sentinel')
  const url = `http://127.0.0.1:${port}`
  let child: ChildProcess | undefined
  let logs = ''
  const start = async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: String(port), WORK_DIR: dir, SESSIONS_DIR: dir, SKILLS_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', b => { logs += b })
    child.stderr!.on('data', b => { logs += b })
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(logs)
      try { if ((await fetch(url + '/session')).ok) return } catch {}
      await new Promise(r => setTimeout(r, 30))
    }
    throw new Error('server did not start: ' + logs)
  }
  const stop = async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  }
  const register = async (id: string, overrides = {}) => {
    const response = await fetch(url + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id, model: 'main', provider: 'custom', baseUrl, apiKey: 'main-key', thinkingLevel: 'off',
      smallModel: { model: 'small', provider: 'custom', baseUrl, apiKey: 'small-key' }, ...overrides,
    }) }).catch(error => { throw new Error(logs, { cause: error }) })
    assert.equal(response.status, 200, logs)
  }
  const rename = async (id: string, name: string) => {
    const response = await fetch(`${url}/session/${id}/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    assert.equal(response.status, 200)
    return (await response.json()).name
  }
  const prompt = async (id: string) => {
    const controller = new AbortController()
    const response = await fetch(url + '/event', { signal: controller.signal })
    const events: any[] = []
    const collect = (async () => {
      let buffer = ''
      for await (const chunk of response.body!) {
        buffer += new TextDecoder().decode(chunk)
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
          if (!frame.startsWith('data: ')) continue
          const event = JSON.parse(frame.slice(6))
          if (event.sessionId !== id) continue
          events.push(event)
          // Emulate backend acceptance and native-name synchronization before UI delivery.
          if (event.type === 'session.title') assert.equal(await rename(id, event.data.title), event.data.title)
          if (event.type === 'session.idle') return
        }
      }
    })()
    try {
      const result = await fetch(`${url}/session/${id}/prompt_async`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text: 'Please fix login' }] }) })
      assert.equal(result.status, 204)
      await collect
      return events
    } finally { controller.abort() }
  }
  try {
    await start()
    await register('success')
    const events = await prompt('success')
    assert.deepEqual(events.filter(e => e.type === 'session.title').map(e => e.data.title), ['Please fix login', '修复登录问题'])
    assert.equal(requests[0].model, 'main')
    assert.equal(requests[0].auth, 'Bearer main-key')
    const system = JSON.stringify(requests[0].messages.filter((m: any) => m.role === 'system' || m.role === 'developer'))
    assert.ok(system.includes('Cattery SDK context sentinel'))
    assert.ok(system.includes('Multiline skill description sentinel'))
    assert.ok(!system.includes('Skill body sentinel'))
    assert.deepEqual(requests[0].tools.map((t: any) => t.function.name).sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
    assert.equal(requests[1].model, 'small')
    assert.equal(requests[1].auth, 'Bearer small-key')
    assert.equal(requests[1].tools, undefined)
    const transcript = await readFile(path.join(dir, 'success.json'), 'utf8')
    assert.equal(JSON.parse(transcript).titleAttempted, true)
    assert.ok(!transcript.includes('small-key') && !transcript.includes('main-key'))
    assert.ok(!transcript.includes('修复登录问题'))
    assert.equal(SessionManager.open(path.join(dir, 'success.jsonl')).getSessionName(), '修复登录问题')
    assert.equal(await rename('success', '  手动\n名称  '), '手动 名称')
    const namedTranscript = await readFile(path.join(dir, 'success.jsonl'), 'utf8')
    await rename('success', '手动 名称')
    assert.equal(await readFile(path.join(dir, 'success.jsonl'), 'utf8'), namedTranscript)
    assert.equal((await fetch(`${url}/session/success/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 123 }) })).status, 400)
    assert.equal((await fetch(`${url}/session/missing/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'missing' }) })).status, 404)
    assert.equal((await fetch(url + '/stop', { method: 'POST' })).status, 204)
    assert.deepEqual(await (await fetch(url + '/session')).json(), [])
    assert.equal(await readFile(path.join(dir, 'success.json'), 'utf8'), transcript)
    await register('success')
    await stop(); await start(); await register('success')
    assert.equal((await (await fetch(url + '/session/success')).json()).name, '手动 名称')
    assert.equal(SessionManager.open(path.join(dir, 'success.jsonl')).getSessionName(), '手动 名称')
    const count = requests.length
    assert.equal((await prompt('success')).filter(e => e.type === 'session.title').length, 0)
    assert.equal(requests.length, count + 1)
    for (const failure of ['title-error', 'empty', 'clarification', 'timeout']) {
      mode = failure
      await register(failure)
      const result = await prompt(failure)
      assert.deepEqual(result.filter(e => e.type === 'session.title').map(e => e.data.title), ['Please fix login'])
      assert.equal(result.filter(e => e.type === 'session.error').length, 0)
    }
    mode = 'tools'
    await register('tools')
    const toolEvents = await prompt('tools')
    const liveResult = toolEvents.find(e => e.type === 'tool.done')
    assert.match(liveResult.data.output, /^two\n\n\[1 more lines in file/)
    assert.ok(!JSON.stringify(liveResult.data).includes('cattery'))
    const liveHistory = await (await fetch(url + '/session/tools/message')).json()
    assert.deepEqual(liveHistory.flatMap((m: any) => m.events).find((e: any) => e.type === 'tool.done').data, liveResult.data)
    await stop()
    const saved = SessionManager.open(path.join(dir, 'tools.jsonl'))
    saved.appendCompaction('Compacted context sentinel', null, 100000)
    await start()
    assert.deepEqual(await (await fetch(url + '/session/tools/message')).json(), liveHistory)
    mode = 'success'
    await register('isolated', { apiKey: 'isolated-key', model: 'alternate' })
    await register('tools', { smallModel: undefined })
    const isolatedStart = requests.length
    await prompt('isolated')
    await prompt('tools')
    const mainRequests = requests.slice(isolatedStart).filter(r => r.model !== 'small')
    assert.deepEqual(mainRequests.map(r => [r.model, r.auth]), [['alternate', 'Bearer isolated-key'], ['main', 'Bearer main-key']])
    const disk = (await readFile(path.join(dir, 'isolated.jsonl'), 'utf8')) + (await readFile(path.join(dir, 'isolated.json'), 'utf8'))
    assert.ok(!disk.includes('isolated-key'))
    await register('tools', { apiKey: 'rotated-key', model: 'switched', smallModel: undefined })
    const switchedAt = requests.length
    await prompt('tools')
    assert.equal(requests[switchedAt].model, 'switched')
    assert.equal(requests[switchedAt].auth, 'Bearer rotated-key')
    assert.ok(JSON.stringify(requests[switchedAt].messages).includes('Compacted context sentinel'))
    await writeFile(path.join(dir, 'legacy.json'), JSON.stringify({ model: { provider: 'custom', id: 'main' }, messages: [] }))
    assert.equal((await fetch(url + '/session/legacy')).status, 409)
    assert.equal((await fetch(url + '/session/legacy', { method: 'DELETE' })).status, 204)
    await register('legacy')
    mode = 'transient'
    await Promise.all([register('transient', { smallModel: undefined }), register('transient', { smallModel: undefined })])
    const recovered = await prompt('transient')
    assert.ok(transientFailures >= 2)
    assert.ok(!recovered.some(e => e.type === 'session.error'))
    assert.ok(recovered.some(e => e.type === 'message.delta'))
    mode = 'main-error'
    await register('retry')
    const countBefore = requests.length
    const failed = await prompt('retry')
    assert.equal(requests.length, countBefore + 1)
    assert.ok(failed.some(e => e.type === 'session.error'))
    mode = 'success'
    assert.deepEqual((await prompt('retry')).filter(e => e.type === 'session.title').map(e => e.data.title), ['修复登录问题'])
    mode = 'hang'
    await register('stop-running')
    const beforeStop = requests.length
    const pending = prompt('stop-running')
    for (let i = 0; i < 100 && requests.length === beforeStop; i++) await new Promise(r => setTimeout(r, 10))
    assert.ok(requests.length > beforeStop)
    assert.equal((await fetch(url + '/stop', { method: 'POST' })).status, 204)
    assert.ok((await pending).some(e => e.type === 'session.idle'))
    assert.deepEqual(await (await fetch(url + '/session')).json(), [])
    assert.ok((await readFile(path.join(dir, 'stop-running.jsonl'), 'utf8')).includes('Please fix login'))
    mode = 'success'
    await register('stop-running')
    assert.ok((await prompt('stop-running')).some(e => e.type === 'session.idle'))

  } finally {
    await stop()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
