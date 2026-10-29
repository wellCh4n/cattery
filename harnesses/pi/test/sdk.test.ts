import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
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
    if (!title && ['tools', 'workspace', 'questionnaire'].includes(mode) && body.messages.at(-1)?.role !== 'tool') {
      const tool = mode === 'questionnaire' ? {
        name: 'questionnaire', arguments: { questions: [{ id: 'scope', prompt: 'Choose scope', options: [{ label: 'Small' }] }, { id: 'note', prompt: 'Any notes?', options: [] }] },
      } : mode === 'workspace' ? {
        name: 'bash', arguments: { command: 'printf "%s\\n" "$PWD" "$HOME"; cat ~/example.txt; printf home-write > workspace-output.txt' },
      } : { name: 'read', arguments: { path: 'example.txt', offset: 2, limit: 1 } }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'read-call', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    const text = title ? (mode === 'empty' ? '' : JSON.stringify({ title: mode === 'clarification' ? '无法确定对话主题，请提供具体任务。' : '修复登录问题' })) : 'Login fixed.'
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
  const fixtureDir = await realpath(await mkdtemp(path.join(tmpdir(), 'cattery-title-')))
  const dir = path.join(fixtureDir, 'home')
  const skillsDir = path.join(fixtureDir, 'global-skills')
  const sessionsDir = path.join(dir, '.cattery/sessions')
  await mkdir(path.join(dir, '.agents/skills/project-skill'), { recursive: true })
  await writeFile(path.join(dir, '.agents/skills/project-skill/SKILL.md'), '---\nname: project-skill\ndescription: Project skill description sentinel\n---\nProject skill body')
  await writeFile(path.join(dir, 'AGENTS.md'), 'Cattery SDK context sentinel')
  await writeFile(path.join(dir, 'example.txt'), 'one\ntwo\nthree')
  await mkdir(path.join(dir, '.agents/skills/skill-fixture'), { recursive: true })
  await writeFile(path.join(dir, '.agents/skills/skill-fixture/SKILL.md'), '---\nname: skill-fixture\ndescription: >\n  Multiline skill\n  description sentinel\n---\nSkill body sentinel')
  // The global library is installed into projects, never loaded from its mount.
  await mkdir(path.join(skillsDir, 'library-skill'), { recursive: true })
  await writeFile(path.join(skillsDir, 'library-skill/SKILL.md'), '---\nname: library-skill\ndescription: Library skill sentinel\n---\nLibrary body')
  const url = `http://127.0.0.1:${port}`
  let child: ChildProcess | undefined
  let logs = ''
  const start = async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: String(port), HOME: dir, WORK_DIR: undefined, SESSIONS_DIR: undefined, SKILLS_DIR: skillsDir },
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
  const prompt = async (id: string, onQuestion?: () => Promise<void>) => {
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
          if (event.type === 'tool.start' && event.data.tool === 'questionnaire') await onQuestion?.()
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
    const main = requests.find(r => r.model === 'main')
    const small = requests.find(r => r.model === 'small')
    assert.equal(main.auth, 'Bearer main-key')
    const system = JSON.stringify(main.messages.filter((m: any) => m.role === 'system' || m.role === 'developer'))
    assert.ok(system.includes('Cattery SDK context sentinel'))
    assert.ok(system.includes('Multiline skill description sentinel'))
    assert.ok(system.includes('Project skill description sentinel'))
    assert.ok(!system.includes('Library skill sentinel'))
    assert.ok(system.includes(dir))
    assert.ok(!system.includes('Skill body sentinel'))
    assert.deepEqual(main.tools.map((t: any) => t.function.name).sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'questionnaire', 'read', 'write'])
    assert.equal(small.auth, 'Bearer small-key')
    assert.equal(small.tools, undefined)
    // Named from the request alone, like Codex.
    assert.ok(JSON.stringify(small.messages).includes('Please fix login'))
    assert.ok(!JSON.stringify(small.messages).includes('Login fixed.'))
    const transcript = await readFile(path.join(sessionsDir, 'success.json'), 'utf8')
    assert.equal(JSON.parse(transcript).titleAttempted, true)
    assert.ok(!transcript.includes('small-key') && !transcript.includes('main-key'))
    assert.ok(!transcript.includes('修复登录问题'))
    assert.equal(SessionManager.open(path.join(sessionsDir, 'success.jsonl')).getSessionName(), '修复登录问题')
    assert.equal(await rename('success', '  手动\n名称  '), '手动 名称')
    const namedTranscript = await readFile(path.join(sessionsDir, 'success.jsonl'), 'utf8')
    await rename('success', '手动 名称')
    assert.equal(await readFile(path.join(sessionsDir, 'success.jsonl'), 'utf8'), namedTranscript)
    assert.equal((await fetch(`${url}/session/success/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 123 }) })).status, 400)
    assert.equal((await fetch(`${url}/session/missing/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'missing' }) })).status, 404)
    assert.equal((await fetch(url + '/stop', { method: 'POST' })).status, 204)
    assert.deepEqual(await (await fetch(url + '/session')).json(), [])
    assert.equal(await readFile(path.join(sessionsDir, 'success.json'), 'utf8'), transcript)
    await register('success')
    await stop(); await start(); await register('success')
    assert.equal((await (await fetch(url + '/session/success')).json()).name, '手动 名称')
    assert.equal(SessionManager.open(path.join(sessionsDir, 'success.jsonl')).getSessionName(), '手动 名称')
    const count = requests.length
    assert.equal((await prompt('success')).filter(e => e.type === 'session.title').length, 0)
    assert.equal(requests.length, count + 1)
    // Forks copy the whole branch, or the part before a user message.
    const fork = (id: string, body: object) => fetch(`${url}/session/${id}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const turns = async (id: string) => (await (await fetch(`${url}/session/${id}/message`)).json()).filter((m: any) => m.messageId !== 'session-state')
    const source = await turns('success')
    assert.deepEqual(source.map((m: any) => m.role), ['user', 'assistant', 'user', 'assistant'])
    assert.equal((await fork('success', { id: 'success-all' })).status, 200)
    assert.deepEqual(await turns('success-all'), source)
    assert.equal((await fork('success', { id: 'success-early', before: source[2].messageId })).status, 200)
    assert.deepEqual(await turns('success-early'), source.slice(0, 2))
    assert.equal((await fork('success', { id: 'success-empty', before: source[0].messageId })).status, 200)
    assert.deepEqual(await turns('success-empty'), [])
    assert.equal(JSON.parse(await readFile(path.join(sessionsDir, 'success-early.json'), 'utf8')).titleAttempted, true)
    assert.equal(JSON.parse(await readFile(path.join(sessionsDir, 'success-empty.json'), 'utf8')).titleAttempted, false)
    assert.equal((await fork('success', { id: 'success-all' })).status, 409)
    assert.equal((await fork('success', { id: 'success-x', before: 'u0' })).status, 404)
    assert.equal((await fork('missing', { id: 'success-y' })).status, 404)
    await register('success-early')
    assert.equal((await prompt('success-early')).filter(e => e.type === 'session.title').length, 0)
    assert.equal((await turns('success-early')).length, 4)
    assert.deepEqual(await turns('success'), source)
    // A channel's conversation lives apart from sessions, found by id alone.
    const channelsDir = path.join(dir, '.cattery/channels')
    await register('channel', { kind: 'channel', smallModel: undefined })
    await prompt('channel')
    assert.ok(await readFile(path.join(channelsDir, 'channel.jsonl'), 'utf8'))
    await assert.rejects(readFile(path.join(sessionsDir, 'channel.json'), 'utf8'))
    await stop(); await start()
    assert.equal((await turns('channel')).length, 2)
    await register('channel', { smallModel: undefined })
    await assert.rejects(readFile(path.join(sessionsDir, 'channel.jsonl'), 'utf8'))
    // Its fork is a session.
    assert.equal((await fork('channel', { id: 'channel-fork' })).status, 200)
    assert.equal((await turns('channel-fork')).length, 2)
    assert.ok(await readFile(path.join(sessionsDir, 'channel-fork.jsonl'), 'utf8'))
    assert.equal((await fork('success', { id: 'channel' })).status, 409)
    assert.equal((await fetch(url + '/session/channel', { method: 'DELETE' })).status, 204)
    await assert.rejects(readFile(path.join(channelsDir, 'channel.jsonl'), 'utf8'))
    assert.deepEqual(await turns('channel'), [])
    mode = 'workspace'
    await register('workspace', { smallModel: undefined })
    const workspaceEvents = await prompt('workspace')
    const workspaceOutput = workspaceEvents.find(e => e.type === 'tool.done').data.output
    assert.equal(workspaceOutput, `${dir}\n${dir}\none\ntwo\nthree`)
    assert.equal(await readFile(path.join(dir, 'workspace-output.txt'), 'utf8'), 'home-write')
    assert.equal(SessionManager.open(path.join(sessionsDir, 'workspace.jsonl')).getCwd(), dir)
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
    const saved = SessionManager.open(path.join(sessionsDir, 'tools.jsonl'))
    saved.appendCompaction('Compacted context sentinel', null, 100000)
    await start()
    const restoredHistory = await (await fetch(url + '/session/tools/message')).json()
    const liveUsage = liveHistory.flatMap((m: any) => m.events).find((e: any) => e.type === 'session.usage')
    const restoredUsage = restoredHistory.flatMap((m: any) => m.events).find((e: any) => e.type === 'session.usage')
    assert.equal(typeof liveUsage.data.contextTokens, 'number')
    assert.deepEqual(restoredUsage.data, { ...liveUsage.data, contextTokens: null })
    // Compaction changes live context usage, while the full UI history is preserved.
    const withoutUsage = (items: any[]) => items.map(m => ({ ...m, events: m.events.filter((e: any) => e.type !== 'session.usage' && e.type !== 'session.state') }))
    assert.deepEqual(withoutUsage(restoredHistory), withoutUsage(liveHistory))
    mode = 'success'
    await register('isolated', { apiKey: 'isolated-key', model: 'alternate' })
    await register('tools', { smallModel: undefined })
    const isolatedStart = requests.length
    await prompt('isolated')
    await prompt('tools')
    const mainRequests = requests.slice(isolatedStart).filter(r => r.model !== 'small')
    assert.deepEqual(mainRequests.map(r => [r.model, r.auth]), [['alternate', 'Bearer isolated-key'], ['main', 'Bearer main-key']])
    const disk = (await readFile(path.join(sessionsDir, 'isolated.jsonl'), 'utf8')) + (await readFile(path.join(sessionsDir, 'isolated.json'), 'utf8'))
    assert.ok(!disk.includes('isolated-key'))
    await register('tools', { apiKey: 'rotated-key', model: 'switched', smallModel: undefined })
    const switchedAt = requests.length
    await prompt('tools')
    assert.equal(requests[switchedAt].model, 'switched')
    assert.equal(requests[switchedAt].auth, 'Bearer rotated-key')
    assert.ok(JSON.stringify(requests[switchedAt].messages).includes('Compacted context sentinel'))
    await writeFile(path.join(sessionsDir, 'legacy.json'), JSON.stringify({ model: { provider: 'custom', id: 'main' }, messages: [] }))
    assert.equal((await fetch(url + '/session/legacy')).status, 409)
    assert.equal((await fetch(url + '/session/legacy', { method: 'DELETE' })).status, 204)
    await register('legacy')
    mode = 'questionnaire'
    await register('questions', { smallModel: undefined })
    const answerURL = `${url}/session/questions/questionnaire/read-call`
    const answer = (body: unknown, endpoint = answerURL) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const questionEvents = await prompt('questions', async () => {
      const pendingHistory = await (await fetch(url + '/session/questions/message')).json()
      assert.ok(pendingHistory.flatMap((m: any) => m.events).some((e: any) => e.type === 'session.state' && e.data.busy))
      assert.ok(pendingHistory.flatMap((m: any) => m.events).some((e: any) => e.type === 'tool.start' && e.data.tool === 'questionnaire'))
      assert.equal((await answer({ answers: [] })).status, 400)
      assert.equal((await answer({ cancelled: true }, `${url}/session/legacy/questionnaire/read-call`)).status, 409)
      const body = { answers: [{ id: 'scope', value: 'Small', wasCustom: false }, { id: 'note', value: 'Keep it simple', wasCustom: true }] }
      assert.equal((await answer(body)).status, 204)
      assert.equal((await answer(body)).status, 409)
    })
    assert.equal(JSON.parse(questionEvents.find(e => e.type === 'tool.start').data.input).questions[0].options[0].value, 'Small')
    const questionResult = questionEvents.find(e => e.type === 'tool.done').data
    assert.equal(questionResult.parsed.answers[0].label, 'Small')
    assert.equal(questionResult.parsed.answers[0].index, 1)
    assert.equal(questionResult.parsed.answers[1].wasCustom, true)
    assert.ok(questionEvents.some(e => e.type === 'message.delta'))
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('Keep it simple'))
    const questionHistory = await (await fetch(url + '/session/questions/message')).json()
    assert.equal(JSON.parse(questionHistory.flatMap((m: any) => m.events).find((e: any) => e.type === 'tool.start').data.input).questions[0].options[0].value, 'Small')
    assert.deepEqual(questionHistory.flatMap((m: any) => m.events).find((e: any) => e.type === 'tool.done').data, questionResult)
    await register('cancel-question', { smallModel: undefined })
    const cancelled = await prompt('cancel-question', async () => {
      assert.equal((await answer({ cancelled: true }, `${url}/session/cancel-question/questionnaire/read-call`)).status, 204)
    })
    assert.equal(cancelled.find(e => e.type === 'tool.done').data.parsed.cancelled, true)
    await register('abort-question', { smallModel: undefined })
    const aborted = await prompt('abort-question', async () => {
      assert.equal((await fetch(`${url}/session/abort-question/abort`, { method: 'POST' })).status, 204)
    })
    assert.ok(aborted.some(e => e.type === 'session.idle'))
    assert.equal((await answer({ cancelled: true }, `${url}/session/abort-question/questionnaire/read-call`)).status, 409)
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
    // One main request (no retry of a 400) and the title, which no longer waits for a reply.
    assert.equal(requests.length, countBefore + 2)
    assert.ok(failed.some(e => e.type === 'session.error'))
    assert.deepEqual(failed.filter(e => e.type === 'session.title').map(e => e.data.title), ['Please fix login', '修复登录问题'])
    mode = 'success'
    assert.equal((await prompt('retry')).filter(e => e.type === 'session.title').length, 0)
    mode = 'hang'
    await register('stop-running')
    const beforeStop = requests.length
    const pending = prompt('stop-running')
    for (let i = 0; i < 100 && requests.length === beforeStop; i++) await new Promise(r => setTimeout(r, 10))
    assert.ok(requests.length > beforeStop)
    assert.equal((await fetch(url + '/stop', { method: 'POST' })).status, 204)
    assert.ok((await pending).some(e => e.type === 'session.idle'))
    assert.deepEqual(await (await fetch(url + '/session')).json(), [])
    assert.ok((await readFile(path.join(sessionsDir, 'stop-running.jsonl'), 'utf8')).includes('Please fix login'))
    mode = 'success'
    await register('stop-running')
    assert.ok((await prompt('stop-running')).some(e => e.type === 'session.idle'))

  } finally {
    await stop()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(fixtureDir, { recursive: true, force: true })
  }
})
