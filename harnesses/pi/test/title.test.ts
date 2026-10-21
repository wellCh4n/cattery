import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Exercise the real Agent + pi-ai HTTP path with a local model provider.
test('automatic titles use small_model, preserve fallback on failure, and survive reload', { timeout: 30000 }, async () => {
  const requests: any[] = []
  let mode = 'success'
  const provider = createServer(async (req, res) => {
    let data = ''
    for await (const chunk of req) data += chunk
    const body = JSON.parse(data)
    requests.push({ ...body, auth: req.headers.authorization })
    const title = body.model === 'small'
    if (!title && mode === 'hang') return
    if ((title && mode === 'title-error') || (!title && mode === 'main-error')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'test failure', type: 'invalid_request_error' } }))
      return
    }
    if (title && mode === 'timeout') return // Client aborts the title request after 15 seconds.
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
  const register = async (id: string) => {
    const response = await fetch(url + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id, model: 'main', provider: 'custom', baseUrl, apiKey: 'main-key', thinkingLevel: 'off',
      smallModel: { model: 'small', provider: 'custom', baseUrl, apiKey: 'small-key' },
    }) })
    assert.equal(response.status, 200)
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
    assert.equal(requests[1].model, 'small')
    assert.equal(requests[1].auth, 'Bearer small-key')
    assert.equal(requests[1].tools, undefined)
    const transcript = await readFile(path.join(dir, 'success.json'), 'utf8')
    assert.equal(JSON.parse(transcript).titleAttempted, true)
    assert.ok(!transcript.includes('small-key') && !transcript.includes('main-key'))
    assert.ok(!transcript.includes('修复登录问题'))
    assert.equal((await fetch(url + '/stop', { method: 'POST' })).status, 204)
    assert.deepEqual(await (await fetch(url + '/session')).json(), [])
    assert.equal(await readFile(path.join(dir, 'success.json'), 'utf8'), transcript)
    await register('success')
    await stop(); await start(); await register('success')
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
    assert.ok(JSON.parse(await readFile(path.join(dir, 'stop-running.json'), 'utf8')).messages.length > 0)
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
