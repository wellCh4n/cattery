// Web servers listening in the sandbox, for Cattery's Apps view. The harness
// shares the container's PID namespace with every server the agent or the web
// terminal starts, and runs as the same user, so it can match each listening
// socket to the process holding it.

import fs from 'node:fs/promises'
import path from 'node:path'

export interface ListeningApp {
  port: number
  // The process holding the socket, when it is visible from here.
  pid?: number
  command?: string
  // ISO time the process started.
  startedAt?: string
}

const TCP_LISTEN = '0A'
// Linux reports process start times in USER_HZ, fixed at 100 for userspace.
const USER_HZ = 100

interface Holder { pid: number; start: number }

// Listening sockets from /proc/net/tcp{,6}: socket inode → port.
async function listeningSockets(proc: string): Promise<Map<string, number>> {
  const sockets = new Map<string, number>()
  for (const file of ['net/tcp', 'net/tcp6']) {
    let text: string
    try { text = await fs.readFile(path.join(proc, file), 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      const f = line.trim().split(/\s+/)
      if (f.length < 10 || f[3] !== TCP_LISTEN) continue
      const port = parseInt(f[1].split(':')[1] ?? '', 16)
      if (Number.isInteger(port) && f[9] !== '0') sockets.set(f[9], port)
    }
  }
  return sockets
}

// The start time in clock ticks since boot: field 22 of /proc/<pid>/stat,
// counted after the parenthesised command name, which may hold spaces.
function startTicks(stat: string): number | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) ? ticks : undefined
}

export async function listeningApps(proc = '/proc', now = Date.now()): Promise<ListeningApp[]> {
  const sockets = await listeningSockets(proc)
  const holders = new Map<number, Holder>()
  if (sockets.size) {
    for (const entry of await fs.readdir(proc)) {
      if (!/^\d+$/.test(entry)) continue
      let fds: string[]
      try { fds = await fs.readdir(path.join(proc, entry, 'fd')) } catch { continue }
      for (const fd of fds) {
        let link: string
        try { link = await fs.readlink(path.join(proc, entry, 'fd', fd)) } catch { continue }
        const port = sockets.get(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? '')
        if (port === undefined) continue
        const stat = await fs.readFile(path.join(proc, entry, 'stat'), 'utf8').catch(() => '')
        const holder = { pid: Number(entry), start: startTicks(stat) ?? Infinity }
        // Forked workers share the socket; the earliest process is the server.
        const prev = holders.get(port)
        if (!prev || holder.start < prev.start || (holder.start === prev.start && holder.pid < prev.pid)) holders.set(port, holder)
      }
    }
  }
  const uptime = Number((await fs.readFile(path.join(proc, 'uptime'), 'utf8').catch(() => '')).split(' ')[0])
  const apps: ListeningApp[] = []
  for (const port of [...new Set(sockets.values())].sort((a, b) => a - b)) {
    const holder = holders.get(port)
    if (!holder) { apps.push({ port }); continue }
    const cmdline = await fs.readFile(path.join(proc, String(holder.pid), 'cmdline'), 'utf8').catch(() => '')
    const command = cmdline.split('\0').filter(Boolean).join(' ')
    const startedAt = Number.isFinite(holder.start) && Number.isFinite(uptime)
      ? new Date(now - (uptime - holder.start / USER_HZ) * 1000).toISOString()
      : undefined
    apps.push({ port, pid: holder.pid, ...(command ? { command } : {}), ...(startedAt ? { startedAt } : {}) })
  }
  return apps
}

export interface StopOptions {
  proc?: string
  kill?: (pid: number, signal: NodeJS.Signals) => void
  // How long the server gets to exit on SIGTERM before SIGKILL.
  graceMs?: number
  pollMs?: number
}

export class StopError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function listening(proc: string, port: number): Promise<boolean> {
  return [...(await listeningSockets(proc)).values()].includes(port)
}

// stopApp ends the process holding port: SIGTERM, then SIGKILL if the port is
// still open after the grace period. The process is looked up afresh, never
// taken from the caller. Returns whether SIGKILL was needed.
export async function stopApp(port: number, opts: StopOptions = {}): Promise<{ forced: boolean }> {
  const { proc = '/proc', kill = process.kill.bind(process), graceMs = 3000, pollMs = 100 } = opts
  const app = (await listeningApps(proc)).find(a => a.port === port)
  if (!app) throw new StopError(`nothing listens on port ${port}`, 404)
  if (app.pid === undefined) throw new StopError(`the process on port ${port} is not visible from the agent container`, 404)
  if (app.pid === process.pid) throw new StopError('port belongs to the agent', 403)
  const signal = (sig: NodeJS.Signals) => {
    try { kill(app.pid!, sig) } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return
      throw new StopError(code === 'EPERM' ? `not allowed to stop process ${app.pid}` : String(err), code === 'EPERM' ? 403 : 500)
    }
  }
  signal('SIGTERM')
  for (let waited = 0; waited < graceMs; waited += pollMs) {
    await sleep(pollMs)
    if (!(await listening(proc, port))) return { forced: false }
  }
  signal('SIGKILL')
  return { forced: true }
}
