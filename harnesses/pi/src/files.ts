// The project workspace over HTTP, for Cattery's file browser, LaTeX
// previews, skill installs and app previews. Internal-only: the backend checks
// project access and proxies to these routes. Paths are workspace-relative
// (`/` is the workspace root) and cannot climb out of it.
//
//   GET    /list?path=                  → [{name, type, size, mtime}]  (dirs first)
//   GET    /read?path=&limit=           → {path, size, truncated, binary, content?, mtime}
//   PUT    /save?path=&mtime=  <body>   → {path, size, mtime}  (409 if changed since mtime)
//   GET    /raw?path=                   → file bytes, typed for inline display
//   GET    /download?path=              → file bytes as an attachment
//   POST   /upload?path=&name= <body>   → {path, name, size}  (writes <path>/<name>)
//   DELETE /delete?path=                → 204  (recursive)
//   POST   /rename?from=&to=            → {path, name}  (to: a new base name)
//   POST   /move?from=&to=              → {path, name}  (to: a destination directory)
//   POST   /mkdir?path=&name=           → {path, name}
//   POST   /extract?path=  <tar>        → {path, files}  (replaces the directory)
//   GET    /latex?path=                 → LatexState  (cached preview)
//   POST   /latex?path=                 → LatexState  (compile with XeLaTeX)
//   *      /proxy/<port>/<path>         → the server on localhost:<port>, HTTP and WebSocket
//
// Errors are plain text. Bodies are read raw, so the router must run before
// any body parser.

import express, { type Request, type Response, type Router } from 'express'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Keeps the frontend snappy; also the largest file /save accepts.
const MAX_READ_BYTES = 2 * 1024 * 1024
// Protects against huge directories.
const DIR_ENTRY_LIMIT = 2000

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const fail = (res: Response, status: number, message: string) =>
  void res.status(status).type('text/plain').send(message + '\n')

const param = (req: Request, name: string) => {
  const value = req.query[name]
  return typeof value === 'string' ? value : ''
}

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code

// lstat/stat that answer null for a missing path.
async function statOrNull(p: string, follow = true) {
  try { return await (follow ? fs.stat(p, { bigint: true }) : fs.lstat(p, { bigint: true })) } catch (err) {
    if (code(err) === 'ENOENT' || code(err) === 'ENOTDIR') return null
    throw err
  }
}

// The workspace-relative path rel under root. Normalizing it as an absolute
// path drops every leading `..`, so the result never leaves root.
export function resolveIn(root: string, rel: string): string {
  // resolve() also drops a trailing slash, so `/` is root itself.
  return path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/^\/+/, '')))
}

// root-relative path of abs, `/`-rooted.
const relOf = (root: string, abs: string) => '/' + path.relative(root, abs).split(path.sep).join('/')

// A bare entry name: `to` / `name` parameters must not reach other directories.
function baseName(name: string): string | null {
  const cleaned = path.posix.basename(path.posix.normalize('/' + name))
  return cleaned === '' || cleaned === '.' || name.includes('/') || name.includes('\\') ? null : cleaned
}

// The heuristic git uses: a NUL byte in the first chunk.
const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0)

async function readBody(req: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'file too large to save')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function fileDigest(p: string): Promise<string> {
  try {
    if (!(await fs.stat(p)).isFile()) return ''
    const hash = createHash('sha256')
    await pipeline(createReadStream(p), hash)
    return hash.digest('hex')
  } catch {
    return ''
  }
}

// Streams a file, with Range and caching headers. Errors after the headers
// went out (the client left) only end the response.
function sendFile(res: Response, abs: string) {
  res.sendFile(abs, { dotfiles: 'allow' }, err => {
    if (!err) return
    if (res.headersSent) res.destroy()
    else fail(res, 500, err.message)
  })
}

// ── Tar extraction ───────────────────────────────────────────────────────────

// Exact-length reads over a stream.
class StreamReader {
  private buf: Buffer = Buffer.alloc(0)
  private readonly chunks: AsyncIterator<Buffer>
  private ended = false
  constructor(stream: Readable) { this.chunks = stream[Symbol.asyncIterator]() }

  // n bytes, or fewer only at the end of the stream.
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n && !this.ended) {
      const { value, done } = await this.chunks.next()
      if (done) this.ended = true
      else this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(out.length)
    return out
  }
}

const BLOCK = 512
const cString = (b: Buffer) => { const end = b.indexOf(0); return b.subarray(0, end < 0 ? b.length : end).toString('utf8') }

function tarNumber(field: Buffer): number {
  // Base-256 for values too large for octal.
  if (field[0] & 0x80) return field.subarray(1).reduce((n, byte) => n * 256 + byte, field[0] & 0x7f)
  const text = cString(field).trim()
  const n = text === '' ? 0 : parseInt(text, 8)
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'invalid tar: invalid header')
  return n
}

// The path a PAX extended header sets for the next entry.
function paxPath(data: Buffer): string | undefined {
  let found: string | undefined
  for (let pos = 0; pos < data.length;) {
    const space = data.indexOf(0x20, pos)
    const len = parseInt(data.subarray(pos, space).toString(), 10)
    if (space < 0 || !(len > 0)) break
    const [key, ...value] = data.subarray(space + 1, pos + len - 1).toString('utf8').split('=')
    if (key === 'path') found = value.join('=')
    pos += len
  }
  return found
}

// Unpacks regular files and directories from a tar stream under dir, refusing
// entries that would land outside it. Answers the number of files.
export async function extractTar(body: Readable, dir: string): Promise<number> {
  const reader = new StreamReader(body)
  const read = async (n: number) => {
    const out = await reader.read(n)
    if (out.length < n) throw new HttpError(400, 'invalid tar: unexpected EOF')
    return out
  }
  let files = 0
  let nextName: string | undefined
  for (;;) {
    const header = await reader.read(BLOCK)
    if (header.length === 0 || header.every(b => b === 0)) return files
    if (header.length < BLOCK) throw new HttpError(400, 'invalid tar: unexpected EOF')
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
    if (sum !== tarNumber(header.subarray(148, 156))) throw new HttpError(400, 'invalid tar: invalid header')

    const size = tarNumber(header.subarray(124, 136))
    const padded = Math.ceil(size / BLOCK) * BLOCK
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    if (type === 'x' || type === 'L') {
      const data = (await read(padded)).subarray(0, size)
      nextName = type === 'L' ? cString(data) : paxPath(data) ?? nextName
      continue
    }
    if (type === 'g') { await read(padded); continue }

    const prefix = header.subarray(257, 263).toString('latin1') === 'ustar\0' ? cString(header.subarray(345, 500)) : ''
    const name = nextName ?? (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)))
    nextName = undefined
    const rel = path.posix.normalize('/' + name)
    if (rel === '/') { await read(padded); continue }
    const target = path.join(dir, rel)
    if (!target.startsWith(dir + path.sep)) throw new HttpError(400, `entry escapes destination: ${name}`)

    if (type === '5') {
      await fs.mkdir(target, { recursive: true })
      await read(padded)
    } else if (type === '0' || type === '7') {
      await fs.mkdir(path.dirname(target), { recursive: true })
      const out = await fs.open(target, 'w', (tarNumber(header.subarray(100, 108)) & 0o777) | 0o600)
      try {
        for (let left = size; left > 0;) {
          const chunk = await read(Math.min(left, 64 * 1024))
          await out.write(chunk)
          left -= chunk.length
        }
      } finally {
        await out.close()
      }
      await read(padded - size)
      files++
    } else {
      throw new HttpError(400, `unsupported entry type: ${name}`)
    }
  }
}

// ── LaTeX previews ───────────────────────────────────────────────────────────

export interface LatexState {
  pdf?: string
  version?: string
  stale: boolean
  dependencies?: Record<string, string>
}

const COMPILE_TIMEOUT_MS = 60_000
// Only the final 16 KiB of compiler diagnostics are kept.
const LOG_LIMIT = 16384
let compiling = false

// The real .tex path and its preview cache directory.
async function latexPaths(root: string, rel: string) {
  let abs: string, base: string
  try {
    abs = await fs.realpath(resolveIn(root, rel))
    base = await fs.realpath(root)
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
  if (!abs.startsWith(base + path.sep) || path.extname(abs).toLowerCase() !== '.tex') {
    throw new HttpError(400, 'expected a .tex file inside the workspace')
  }
  if (!(await statOrNull(abs))?.isFile()) throw new HttpError(400, 'expected a regular .tex file')
  const cache = path.join(base, '.cattery', 'latex', createHash('sha256').update(abs).digest('hex'))
  // Never follow workspace-controlled cache symlinks.
  for (let p = cache; p !== base; p = path.dirname(p)) {
    const info = await statOrNull(p, false)
    if (info && !info.isDirectory()) throw new HttpError(400, 'invalid preview cache directory')
  }
  return { abs, base, cache }
}

async function readLatexState(base: string, abs: string, cache: string): Promise<LatexState> {
  try {
    const state = JSON.parse(await fs.readFile(path.join(cache, 'state.json'), 'utf8')) as LatexState
    if (await statOrNull(path.join(cache, 'preview.pdf'))) {
      for (const [dep, hash] of Object.entries(state.dependencies ?? {})) {
        if (await fileDigest(dep) !== hash) state.stale = true
      }
      return state
    }
  } catch { /* no compiled preview yet */ }
  // An existing sibling PDF is useful even before the first manual compile.
  const pdf = abs.slice(0, abs.length - path.extname(abs).length) + '.pdf'
  const info = await statOrNull(pdf)
  if (info?.isFile()) return { pdf: relOf(base, pdf), version: String(info.mtimeNs), stale: true }
  return { stale: false }
}

// Runs xelatex once. Answers whether it succeeded; cancel() kills its whole
// process group.
function runXelatex(abs: string, outDir: string, log: { text: string }, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('xelatex', ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-recorder',
      '-jobname=preview', `-output-directory=${outDir}`, `./${path.basename(abs)}`], {
      cwd: path.dirname(abs),
      // HOME outside the workspace keeps TeX caches out of the file browser.
      env: { ...process.env, HOME: os.tmpdir(), openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: outDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const append = (chunk: Buffer) => { log.text = (log.text + chunk.toString()).slice(-LOG_LIMIT) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ } }
    signal.addEventListener('abort', kill, { once: true })
    child.once('error', err => {
      signal.removeEventListener('abort', kill)
      reject(code(err) === 'ENOENT' ? new HttpError(503, 'LaTeX compiler is unavailable. Rebuild the pi image.') : err)
    })
    child.once('close', status => {
      signal.removeEventListener('abort', kill)
      resolve(status === 0)
    })
  })
}

async function compileLatex(req: Request, res: Response, root: string) {
  const { abs, base, cache } = await latexPaths(root, param(req, 'path'))
  if (compiling) throw new HttpError(409, 'Another document is compiling. Try again shortly.')
  compiling = true
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), COMPILE_TIMEOUT_MS)
  const onClose = () => { if (!res.writableFinished) abort.abort() }
  res.once('close', onClose)
  let temp: string | undefined
  try {
    await fs.mkdir(cache, { recursive: true })
    temp = await fs.mkdtemp(path.join(cache, 'build-'))
    const started = Date.now()
    const sourceHash = await fileDigest(abs)
    const log = { text: '' }
    // Two passes resolve document cross-references. No shell or project rc files.
    for (let pass = 0; pass < 2; pass++) {
      if (!(await runXelatex(abs, temp, log, abort.signal))) {
        throw new HttpError(422, abort.signal.aborted
          ? 'Compilation cancelled or exceeded the 60 second limit. The previous preview is preserved.'
          : 'Compilation failed. The previous preview is preserved.\n' + log.text)
      }
    }
    const state: LatexState = { dependencies: { [abs]: sourceHash }, version: String(BigInt(Date.now()) * 1_000_000n), stale: false }
    let recorder: string
    try { recorder = await fs.readFile(path.join(temp, 'preview.fls'), 'utf8') } catch {
      throw new HttpError(500, 'Compiler did not produce dependency information')
    }
    for (const line of recorder.split('\n')) {
      if (!line.startsWith('INPUT ')) continue
      const dep = path.resolve(path.dirname(abs), line.slice('INPUT '.length))
      if (!dep.startsWith(base + path.sep) || dep.startsWith(cache + path.sep)) continue
      if (dep !== abs) state.dependencies![dep] = await fileDigest(dep)
      const info = await statOrNull(dep)
      if (!info || Number(info.mtimeMs) > started) state.stale = true
    }
    if (await fileDigest(abs) !== sourceHash) state.stale = true
    state.pdf = relOf(base, path.join(cache, 'preview.pdf'))
    await fs.writeFile(path.join(temp, 'state.json'), JSON.stringify(state))
    await fs.rename(path.join(temp, 'preview.pdf'), path.join(cache, 'preview.pdf'))
    await fs.rename(path.join(temp, 'state.json'), path.join(cache, 'state.json'))
    res.json(state)
  } finally {
    clearTimeout(timer)
    res.off('close', onClose)
    compiling = false
    if (temp) await fs.rm(temp, { recursive: true, force: true })
  }
}

// ── App previews ─────────────────────────────────────────────────────────────

// Dials localhost over IPv4, then IPv6: Node resolves "localhost" to ::1
// first, so a dev server may listen on either.
function dialLocal(port: number): Promise<net.Socket> {
  const connect = (host: string) => new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 5000 })
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('timeout', () => socket.destroy(new Error('connect timeout')))
    socket.once('error', reject)
  })
  return connect('127.0.0.1').catch(err => connect('::1').catch(() => { throw err }))
}

// /proxy/<port>/<path> → the port and the path to request there.
function proxyTarget(url: string): { port: number; path: string } | null {
  const match = /^\/proxy\/([^/?]*)(.*)$/s.exec(url)
  const port = Number(match?.[1])
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { port, path: match[2].startsWith('/') ? match[2] : '/' + match[2] }
}

// Keeps redirects inside the preview: absolute URLs to the server itself
// (http://localhost:<port>/x) become root-relative.
export function rewriteLocation(loc: string, port: number): string {
  let url: URL
  try { url = new URL(loc) } catch { return loc }
  if (url.port !== String(port) || !['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) return loc
  return url.pathname + url.search + url.hash
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const named = String(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !named.includes(name)) out[name] = value
  }
  return out
}

async function proxy(req: Request, res: Response) {
  const target = proxyTarget(req.originalUrl)
  if (!target) throw new HttpError(400, 'invalid port')
  let socket: net.Socket
  try {
    socket = await dialLocal(target.port)
  } catch (err) {
    throw new HttpError(502, `nothing is serving HTTP on port ${target.port} in the sandbox: ${(err as Error).message}`)
  }
  // The backend's X-Forwarded-* pass through: they describe the browser's request.
  const headers = { ...forwardHeaders(req.headers), host: `localhost:${target.port}`, connection: 'close' }
  const upstream = http.request({ method: req.method, path: target.path, headers, createConnection: () => socket })
  // Unhandled stream errors would crash the agent: every side gets a listener.
  res.once('close', () => { if (!res.writableFinished) upstream.destroy() })
  req.on('error', () => upstream.destroy())
  upstream.once('response', upstreamRes => {
    upstreamRes.on('error', () => res.destroy())
    const out = forwardHeaders(upstreamRes.headers)
    if (typeof out.location === 'string') out.location = rewriteLocation(out.location, target.port)
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, out)
    upstreamRes.pipe(res)
  })
  upstream.on('error', err => {
    if (res.headersSent) res.destroy()
    else fail(res, 502, `nothing is serving HTTP on port ${target.port} in the sandbox: ${err.message}`)
  })
  req.pipe(upstream)
}

// Forwards a WebSocket upgrade under /proxy/<port>/ (a dev server's HMR
// socket); the server's 'upgrade' listener calls this.
export async function proxyUpgrade(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
  client.on('error', () => client.destroy())
  const target = proxyTarget(req.url ?? '')
  if (!target) return void client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  let upstream: net.Socket
  try {
    upstream = await dialLocal(target.port)
  } catch {
    return void client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  }
  upstream.on('error', () => client.destroy())
  client.on('close', () => upstream.destroy())
  let request = `${req.method} ${target.path} HTTP/1.1\r\nHost: localhost:${target.port}\r\n`
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== 'host') request += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
  }
  upstream.write(request + '\r\n')
  if (head.length) upstream.write(head)
  upstream.pipe(client).pipe(upstream)
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function filesRouter(workspace: string): Router {
  const root = path.resolve(workspace)
  const router = express.Router()
  const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    handler(req, res).catch(err => {
      if (res.headersSent) return void res.destroy()
      if (err instanceof HttpError) return fail(res, err.status, err.message)
      if (code(err) === 'ENOENT') return fail(res, 404, 'not found')
      console.error('[files]', err)
      fail(res, 500, (err as Error).message)
    })
  }
  const resolve = (name: string, req: Request) => resolveIn(root, param(req, name))
  const notRoot = (abs: string, action: string) => { if (abs === root) throw new HttpError(400, `cannot ${action} root`) }
  async function existing(abs: string, follow = true, missing = 'not found') {
    const info = await statOrNull(abs, follow)
    if (!info) throw new HttpError(404, missing)
    return info
  }
  async function directory(abs: string, missing = 'not found', notDir = 'path is not a directory') {
    if (!(await existing(abs, true, missing)).isDirectory()) throw new HttpError(400, notDir)
  }
  async function file(abs: string) {
    const info = await existing(abs)
    if (info.isDirectory()) throw new HttpError(400, 'is a directory')
    return info
  }
  async function absent(abs: string) {
    if (await statOrNull(abs, false)) throw new HttpError(409, 'destination already exists')
  }

  router.get('/list', route(async (req, res) => {
    const abs = resolve('path', req)
    await directory(abs, 'not found', 'not a directory')
    const names = (await fs.readdir(abs)).sort().slice(0, DIR_ENTRY_LIMIT)
    const entries = (await Promise.all(names.map(async name => {
      const info = await statOrNull(path.join(abs, name), false)
      if (!info) return null
      const mtime = Math.floor(Number(info.mtimeMs) / 1000)
      if (info.isSymbolicLink()) return { name, type: 'link', size: 0, mtime }
      if (info.isDirectory()) return { name, type: 'dir', size: 0, mtime }
      return { name, type: 'file', size: Number(info.size), mtime }
    }))).filter(entry => entry !== null)
    // Dirs first, then alphabetical within each group, like IDE file trees.
    entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1)
      : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)
    res.json(entries)
  }))

  router.get('/read', route(async (req, res) => {
    const abs = resolve('path', req)
    const info = await file(abs)
    const asked = Number(param(req, 'limit'))
    const limit = Number.isSafeInteger(asked) && asked > 0 && asked <= MAX_READ_BYTES ? asked : MAX_READ_BYTES
    const handle = await fs.open(abs, 'r')
    let buf: Buffer
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(limit + 1), 0, limit + 1, 0)
      buf = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    const truncated = buf.length > limit
    if (truncated) buf = buf.subarray(0, limit)
    const binary = isBinary(buf)
    // mtime (ns) lets /save refuse to overwrite a file that changed since it
    // was read; a string, since it exceeds what a JavaScript number holds.
    res.json({
      path: param(req, 'path'), size: Number(info.size), truncated, binary,
      ...(binary ? {} : { content: buf.toString('utf8') }), mtime: String(info.mtimeNs),
    })
  }))

  // Replaces an existing file's contents. The body goes to a temp file beside
  // the target, renamed over it, so a failed save never leaves a half-written
  // file; the original mode is kept and symlinks stay in place.
  router.put('/save', route(async (req, res) => {
    const abs = resolve('path', req)
    let target: string
    try { target = await fs.realpath(abs) } catch (err) {
      if (code(err) === 'ENOENT') throw new HttpError(404, 'not found')
      throw err
    }
    const info = await fs.stat(target, { bigint: true })
    if (!info.isFile()) throw new HttpError(400, 'not a regular file')
    const mtime = param(req, 'mtime')
    if (mtime) {
      if (!/^-?\d+$/.test(mtime)) throw new HttpError(400, "invalid 'mtime'")
      if (info.mtimeNs !== BigInt(mtime)) throw new HttpError(409, 'file changed since it was opened')
    }
    const body = await readBody(req, MAX_READ_BYTES)
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fs.writeFile(tmp, body)
      await fs.chmod(tmp, Number(info.mode) & 0o777)
      await fs.rename(tmp, target)
    } finally {
      await fs.rm(tmp, { force: true })
    }
    const saved = await fs.stat(target, { bigint: true })
    res.json({ path: param(req, 'path'), size: Number(saved.size), mtime: String(saved.mtimeNs) })
  }))

  // Raw bytes for inline display (<img>, <video>, PDFs): typed by extension,
  // or as text when an unknown file has no NUL bytes; no Content-Disposition.
  router.get('/raw', route(async (req, res) => {
    const abs = resolve('path', req)
    await file(abs)
    if (!express.static.mime.lookup(abs, '')) {
      const handle = await fs.open(abs, 'r')
      try {
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(8000), 0, 8000, 0)
        res.type(isBinary(buffer.subarray(0, bytesRead)) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
      } finally {
        await handle.close()
      }
    }
    sendFile(res, abs)
  }))

  // The whole file as an attachment, with no size cap.
  router.get('/download', route(async (req, res) => {
    const abs = resolve('path', req)
    await file(abs)
    res.attachment(path.basename(abs))
    res.type('application/octet-stream')
    sendFile(res, abs)
  }))

  // Writes the body to <path>/<name>, overwriting an existing file.
  router.post('/upload', route(async (req, res) => {
    const dir = resolve('path', req)
    await directory(dir)
    const name = baseName(param(req, 'name'))
    if (!name || name === '..') throw new HttpError(400, 'invalid filename')
    const out = createWriteStream(path.join(dir, name))
    await pipeline(req, out)
    res.json({ path: path.posix.join('/', param(req, 'path'), name), name, size: out.bytesWritten })
  }))

  // Hard delete, recursive for directories.
  const remove = route(async (req, res) => {
    const abs = resolve('path', req)
    notRoot(abs, 'delete')
    await existing(abs, false)
    await fs.rm(abs, { recursive: true, force: true })
    res.status(204).end()
  })
  router.delete('/delete', remove)
  router.post('/delete', remove)

  // Renames within the same directory; `to` is a base name.
  router.post('/rename', route(async (req, res) => {
    const from = resolve('from', req)
    notRoot(from, 'rename')
    if (!param(req, 'to')) throw new HttpError(400, "missing 'to'")
    const name = path.posix.basename(path.posix.normalize('/' + param(req, 'to')))
    if (!name || name === '.' || name.includes('\\')) throw new HttpError(400, "invalid 'to'")
    const to = path.join(path.dirname(from), name)
    await existing(from, false)
    await absent(to)
    await fs.rename(from, to)
    res.json({ path: relOf(root, to), name })
  }))

  // Moves into the directory `to`, keeping the base name.
  router.post('/move', route(async (req, res) => {
    const from = resolve('from', req)
    notRoot(from, 'move')
    const toDir = resolve('to', req)
    await directory(toDir, 'destination not found', 'destination is not a directory')
    const source = await existing(from, false)
    const name = path.basename(from)
    if (path.dirname(from) === toDir) return void res.json({ path: relOf(root, from), name })
    // Moving a folder into itself would orphan the subtree.
    if (source.isDirectory() && (toDir === from || toDir.startsWith(from + path.sep))) {
      throw new HttpError(400, 'cannot move a folder into itself')
    }
    const dest = path.join(toDir, name)
    await absent(dest)
    await fs.rename(from, dest)
    res.json({ path: relOf(root, dest), name })
  }))

  router.post('/mkdir', route(async (req, res) => {
    const parent = resolve('path', req)
    await directory(parent)
    const name = baseName(param(req, 'name'))
    if (!name) throw new HttpError(400, "invalid 'name'")
    const dest = path.join(parent, name)
    await absent(dest)
    await fs.mkdir(dest, { mode: 0o755 })
    res.json({ path: relOf(root, dest), name })
  }))

  // Replaces the directory at path with the tar archive in the body. It is
  // unpacked beside the target and swapped in only once complete, so a broken
  // upload leaves the old directory untouched. Installs skills.
  router.post('/extract', route(async (req, res) => {
    const dest = resolve('path', req)
    notRoot(dest, 'replace')
    const current = await statOrNull(dest, false)
    if (current && !current.isDirectory()) throw new HttpError(409, 'path exists and is not a directory')
    const parent = path.dirname(dest)
    await fs.mkdir(parent, { recursive: true })
    const tmp = await fs.mkdtemp(path.join(parent, `.${path.basename(dest)}.extract-`))
    try {
      await fs.chmod(tmp, 0o755)
      const files = await extractTar(req, tmp)
      const old = current ? tmp + '.old' : ''
      if (old) await fs.rename(dest, old)
      try {
        await fs.rename(tmp, dest)
      } catch (err) {
        if (old) await fs.rename(old, dest).catch(() => {})
        throw err
      }
      if (old) await fs.rm(old, { recursive: true, force: true })
      res.json({ path: param(req, 'path'), files })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }))

  router.get('/latex', route(async (req, res) => {
    const { abs, base, cache } = await latexPaths(root, param(req, 'path'))
    res.json(await readLatexState(base, abs, cache))
  }))
  router.post('/latex', route((req, res) => compileLatex(req, res, root)))

  router.all(/^\/proxy\//, route(proxy))
  return router
}
