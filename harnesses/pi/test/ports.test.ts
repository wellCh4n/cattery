import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listeningApps, stopApp } from '../src/ports.ts'

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const row = (port: number, state: string, inode: number) =>
  `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`

// A fake /proc: each process is [pid, comm, start ticks, argv, socket inodes].
async function fakeProc(tcp: string, tcp6: string, procs: [number, string, number, string[], number[]][]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-'))
  await fs.mkdir(path.join(root, 'net'))
  await fs.writeFile(path.join(root, 'net/tcp'), HEADER + tcp)
  await fs.writeFile(path.join(root, 'net/tcp6'), HEADER + tcp6)
  await fs.writeFile(path.join(root, 'uptime'), '1000.00 900.00\n')
  for (const [pid, comm, start, argv, inodes] of procs) {
    const dir = path.join(root, String(pid))
    await fs.mkdir(path.join(dir, 'fd'), { recursive: true })
    await fs.writeFile(path.join(dir, 'stat'), `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`)
    await fs.writeFile(path.join(dir, 'cmdline'), argv.join('\0') + '\0')
    await fs.symlink('/dev/null', path.join(dir, 'fd', '0'))
    for (const [i, inode] of inodes.entries()) await fs.symlink(`socket:[${inode}]`, path.join(dir, 'fd', String(i + 3)))
  }
  return root
}

test('matches each listening port to the process holding it', async () => {
  const proc = await fakeProc(
    row(5173, '0A', 11) + row(5173, '01', 12) + row(8000, '0A', 21),
    row(5173, '0A', 13) + row(9000, '0A', 31),
    [
      [40, 'python3', 40000, ['python3', '-m', 'http.server', '8000'], [21]],
      // A worker forked from the server shares its socket.
      [41, 'my server (x)', 50000, ['gunicorn: worker'], [21]],
      [50, 'node', 60000, ['node', '/app/node_modules/.bin/vite', '--port', '5173'], [11, 13]],
    ],
  )
  const now = Date.parse('2026-10-24T12:00:00Z')
  assert.deepEqual(await listeningApps(proc, now), [
    { port: 5173, pid: 50, command: 'node /app/node_modules/.bin/vite --port 5173', startedAt: new Date(now - 400_000).toISOString() },
    { port: 8000, pid: 40, command: 'python3 -m http.server 8000', startedAt: new Date(now - 600_000).toISOString() },
    // Its process isn't visible here (another container).
    { port: 9000 },
  ])
})

test('no listening sockets lists nothing', async () => {
  const proc = await fakeProc(row(5173, '01', 11), '', [])
  assert.deepEqual(await listeningApps(proc), [])
})

test('stop sends SIGTERM and returns once the port closes', async () => {
  const proc = await fakeProc(row(5173, '0A', 11), '', [[50, 'node', 60000, ['node', 'vite'], [11]]])
  const signals: [number, string][] = []
  const kill = (pid: number, sig: NodeJS.Signals) => {
    signals.push([pid, sig])
    // The server exits: its socket leaves the table.
    void fs.writeFile(path.join(proc, 'net/tcp'), HEADER)
  }
  assert.deepEqual(await stopApp(5173, { proc, kill, graceMs: 500, pollMs: 10 }), { forced: false })
  assert.deepEqual(signals, [[50, 'SIGTERM']])
})

test('stop escalates to SIGKILL when the server ignores SIGTERM', async () => {
  const proc = await fakeProc(row(5173, '0A', 11), '', [[50, 'node', 60000, ['node', 'vite'], [11]]])
  const signals: string[] = []
  assert.deepEqual(await stopApp(5173, { proc, kill: (_pid, sig) => { signals.push(sig) }, graceMs: 50, pollMs: 10 }), { forced: true })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('stop refuses ports without a visible process', async () => {
  const proc = await fakeProc(row(5173, '0A', 11) + row(9000, '0A', 31), '', [[50, 'node', 60000, ['node'], [11]]])
  await assert.rejects(stopApp(8080, { proc, kill: () => {} }), { status: 404 })
  await assert.rejects(stopApp(9000, { proc, kill: () => {} }), { status: 404 })
  const gone = Object.assign(new Error('gone'), { code: 'ESRCH' })
  // A process that already exited counts as stopped once the port closes.
  await fs.writeFile(path.join(proc, 'net/tcp'), HEADER + row(5173, '0A', 11))
  const result = stopApp(5173, { proc, kill: () => { void fs.writeFile(path.join(proc, 'net/tcp'), HEADER); throw gone }, graceMs: 500, pollMs: 10 })
  assert.deepEqual(await result, { forced: false })
})
