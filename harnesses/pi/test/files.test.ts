import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { filesRouter, proxyUpgrade, rewriteLocation, type LatexState } from '../src/files.ts'

// A workspace served by the files router; macOS temp paths can be aliases, so
// the root is resolved like /home/cattery would be.
async function serve() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'files-')))
  const app = express()
  app.use(filesRouter(root))
  const server = app.listen(0, '127.0.0.1')
  server.on('upgrade', (req, socket, head) => void proxyUpgrade(req, socket, head))
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { root, base, close: () => new Promise(resolve => server.close(resolve)) }
}

// A tar archive of regular files, as Go's archive/tar (skillmgr) writes it.
function tarOf(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.write('0', 156)
    header.write('ustar\x0000', 257)
    header.fill(0x20, 148, 156)
    const sum = header.reduce((a, b) => a + b, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, Buffer.from(body), Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

test('extract replaces a directory only with a complete archive', async () => {
  const { root, base, close } = await serve()
  const extract = async (body: Buffer) =>
    (await fetch(`${base}/extract?path=/.agents/skills/demo`, { method: 'POST', body })).status
  try {
    assert.equal(await extract(tarOf({ 'SKILL.md': 'v1', 'assets/a.txt': 'a', 'stale.txt': 'x' })), 200)
    // Reinstalling replaces the folder: files missing from the new archive go.
    assert.equal(await extract(tarOf({ 'SKILL.md': 'v2' })), 200)
    const dir = path.join(root, '.agents/skills/demo')
    assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), 'v2')
    await assert.rejects(fs.stat(path.join(dir, 'stale.txt')))
    // A broken archive leaves the installed folder as it was.
    assert.equal(await extract(Buffer.concat([Buffer.from('not a tar archive at all, padded to a block'), Buffer.alloc(600)])), 400)
    assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), 'v2')
    assert.deepEqual(await fs.readdir(path.dirname(dir)), ['demo'], 'leftover temp dirs')
    // An entry climbing out is cleaned into the destination.
    assert.equal(await extract(tarOf({ '../../escape.txt': 'x' })), 200)
    await assert.rejects(fs.stat(path.join(root, '.agents/escape.txt')))
  } finally {
    await close()
  }
})

test('save writes through symlinks and refuses stale or missing files', async () => {
  const { root, base, close } = await serve()
  try {
    const file = path.join(root, 'a.txt')
    await fs.writeFile(file, 'old', { mode: 0o640 })
    await fs.symlink('a.txt', path.join(root, 'link.txt'))
    // The web client passes back the mtime /read reported, as a string.
    const read = await (await fetch(`${base}/read?path=/link.txt`)).json() as { mtime: unknown, content: string }
    assert.equal(typeof read.mtime, 'string')
    assert.equal(read.content, 'old')
    const put = async (p: string, mtime: string, body: string) =>
      (await fetch(`${base}/save?path=${p}${mtime ? `&mtime=${mtime}` : ''}`, { method: 'PUT', body })).status

    assert.equal(await put('/link.txt', read.mtime as string, 'new'), 200)
    assert.equal(await fs.readFile(file, 'utf8'), 'new')
    assert.ok((await fs.lstat(path.join(root, 'link.txt'))).isSymbolicLink(), 'symlink replaced by a regular file')
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640)
    assert.equal(await put('/a.txt', '1', 'stale'), 409)
    assert.equal(await put('/missing.txt', '', 'x'), 404)
    assert.equal(await put('/../etc/passwd', '', 'x'), 404)
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.txt', 'link.txt'], 'leftover temp files')
  } finally {
    await close()
  }
})

test('file operations stay inside the workspace', async () => {
  const { root, base, close } = await serve()
  const post = (url: string, body?: string) => fetch(base + url, { method: 'POST', body })
  try {
    assert.equal((await post('/mkdir?path=/&name=src')).status, 200)
    assert.equal((await post('/mkdir?path=/&name=src')).status, 409)
    assert.equal((await post('/mkdir?path=/&name=a/b')).status, 400)
    const upload = await (await post('/upload?path=/src&name=main.ts', 'hello')).json()
    assert.deepEqual(upload, { path: '/src/main.ts', name: 'main.ts', size: 5 })
    assert.equal((await post('/upload?path=/src&name=..', 'x')).status, 400)

    const list = await (await fetch(`${base}/list?path=/`)).json() as { name: string, type: string }[]
    assert.deepEqual(list.map(e => [e.name, e.type]), [['src', 'dir']])
    assert.deepEqual(await (await post('/rename?from=/src/main.ts&to=app.ts')).json(), { path: '/src/app.ts', name: 'app.ts' })
    assert.equal((await post('/rename?from=/&to=x')).status, 400)
    assert.equal((await post('/mkdir?path=/&name=lib')).status, 200)
    assert.deepEqual(await (await post('/move?from=/src/app.ts&to=/lib')).json(), { path: '/lib/app.ts', name: 'app.ts' })
    assert.equal((await post('/move?from=/lib&to=/lib')).status, 400)

    const raw = await fetch(`${base}/raw?path=/lib/app.ts`)
    assert.equal(await raw.text(), 'hello')
    const download = await fetch(`${base}/download?path=/lib/app.ts`)
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="app.ts"/)
    assert.equal(download.headers.get('content-type'), 'application/octet-stream')

    assert.equal((await fetch(`${base}/delete?path=/`, { method: 'DELETE' })).status, 400)
    assert.equal((await fetch(`${base}/delete?path=/lib`, { method: 'DELETE' })).status, 204)
    assert.deepEqual(await fs.readdir(root), ['src'])
  } finally {
    await close()
  }
})

test('rewrites redirects to the previewed server', () => {
  for (const [loc, want] of Object.entries({
    '/about': '/about',
    'http://localhost:5173/x?a=1': '/x?a=1',
    'http://127.0.0.1:5173/#top': '/#top',
    'https://example.com/x': 'https://example.com/x',
    'http://localhost:3000/x': 'http://localhost:3000/x',
    'relative/path': 'relative/path',
    '//cdn.example.com/a.js': '//cdn.example.com/a.js',
  })) assert.equal(rewriteLocation(loc, 5173), want, loc)
})

test('proxies HTTP and WebSocket upgrades to a local server', async () => {
  const app = http.createServer((req, res) => {
    if (req.url === '/old') return void res.writeHead(302, { location: `http://localhost:${port}/new` }).end()
    res.end(`path ${req.url} host ${req.headers.host}`)
  })
  app.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n')
    socket.pipe(socket)
  })
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  const port = (app.address() as AddressInfo).port
  const { base, close } = await serve()
  try {
    const res = await fetch(`${base}/proxy/${port}/style.css?v=1`)
    assert.equal(await res.text(), `path /style.css?v=1 host localhost:${port}`)
    const redirect = await fetch(`${base}/proxy/${port}/old`, { redirect: 'manual' })
    assert.equal(redirect.headers.get('location'), '/new')
    assert.equal((await fetch(`${base}/proxy/0/`)).status, 400)

    const echoed = await new Promise<string>((resolve, reject) => {
      const req = http.request(`${base}/proxy/${port}/hmr`, { headers: { connection: 'Upgrade', upgrade: 'echo' } })
      req.on('upgrade', (_res, socket) => {
        socket.once('data', data => { resolve(data.toString()); socket.destroy() })
        socket.write('ping')
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(echoed, 'ping')
  } finally {
    await close()
    app.close()
  }
})

test('LaTeX previews compile, cache and track dependencies', async () => {
  const { root, base, close } = await serve()
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'bin-'))
  await fs.writeFile(path.join(bin, 'xelatex'), `#!/bin/sh
for arg in "$@"; do
 case "$arg" in -output-directory=*) out="\${arg#*=}";; esac
done
if [ -f hang ]; then sleep 30; fi
if [ -f fail ]; then echo 'invalid document'; exit 1; fi
printf '%%PDF-1.4 success' > "$out/preview.pdf"
printf 'INPUT ./main.tex\\nINPUT ./chapter.tex\\n' > "$out/preview.fls"
`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}:${savedPath}`
  const source = path.join(root, 'main.tex')
  const dep = path.join(root, 'chapter.tex')
  const request = (method: string, signal?: AbortSignal) => fetch(`${base}/latex?path=/main.tex`, { method, signal })
  const state = async (method = 'GET') => {
    const res = await request(method)
    assert.equal(res.status, 200, await res.clone().text())
    return await res.json() as LatexState
  }
  try {
    await fs.writeFile(source, 'first')
    await fs.writeFile(dep, 'chapter')
    assert.equal((await state()).pdf, undefined)
    await fs.writeFile(path.join(root, 'main.pdf'), 'existing PDF')
    assert.equal((await state()).pdf, '/main.pdf', 'sibling PDF not reused')

    const first = await state('POST')
    assert.ok(first.pdf && !first.stale, JSON.stringify(first))
    const cached = await state()
    assert.ok(cached.version === first.version && !cached.stale, 'cache not reused')
    await fs.writeFile(dep, 'changed dependency')
    assert.ok((await state()).stale, 'dependency change not detected')
    await state('POST')
    await fs.writeFile(source, 'changed source')
    assert.ok((await state()).stale, 'source change not detected')

    const before = await state()
    await fs.writeFile(path.join(root, 'fail'), '')
    assert.equal((await request('POST')).status, 422)
    const after = await state()
    assert.ok(before.version === after.version && before.pdf === after.pdf, 'failure replaced previous preview')
    await fs.rm(path.join(root, 'fail'))

    // A client that leaves cancels the compile, which frees the slot.
    await fs.writeFile(path.join(root, 'hang'), '')
    const leaving = new AbortController()
    const hanging = request('POST', leaving.signal).catch(() => 'cancelled')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal((await request('POST')).status, 409, 'concurrent compilation accepted')
    const started = Date.now()
    leaving.abort()
    assert.equal(await hanging, 'cancelled')
    assert.equal((await state()).version, before.version, 'cancelled compile replaced PDF')
    await fs.rm(path.join(root, 'hang'))
    // The slot frees once the killed compiler exits.
    let status = 409
    while (status === 409 && Date.now() - started < 3000) {
      await new Promise(resolve => setTimeout(resolve, 50))
      status = (await request('POST')).status
    }
    assert.equal(status, 200, 'compiler did not cancel promptly')
  } finally {
    process.env.PATH = savedPath
    await close()
  }
})

test('LaTeX refuses sources linked from outside the workspace', async () => {
  const { root, base, close } = await serve()
  try {
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'outside-')), 'outside.tex')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, path.join(root, 'main.tex'))
    assert.equal((await fetch(`${base}/latex?path=/main.tex`)).status, 400)
  } finally {
    await close()
  }
})
