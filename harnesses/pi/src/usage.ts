import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Usage } from '@earendil-works/pi-ai'

// Token usage ledger: one JSON line per model request, appended on the
// workspace PVC so it survives agent restarts and outlives the transcripts it
// counts (deleted and forked sessions included — a fork copies a transcript
// but never the ledger). The backend pulls new lines by byte offset and
// deduplicates by id, so re-reading a line is harmless.

// reply: a turn of the session's model; title: the small-model title call;
// compaction: the summary written when the context is compacted.
export type UsageKind = 'reply' | 'title' | 'compaction'

export interface UsageRecord {
  id: string
  sessionId: string
  at: number
  kind: UsageKind
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const MAX_READ_BYTES = 1 << 20

export class UsageLedger {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  record(sessionId: string, kind: UsageKind, model: string, usage: Usage | undefined): void {
    if (!usage) return
    const { input, output, cacheRead, cacheWrite } = usage
    if (!(input || output || cacheRead || cacheWrite)) return
    const rec: UsageRecord = { id: randomUUID(), sessionId, at: Date.now(), kind, model, input, output, cacheRead, cacheWrite }
    // Appends are chained so lines never interleave and keep their order.
    this.tail = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(this.file, JSON.stringify(rec) + '\n')
    }).catch(err => console.error('[usage] append failed', err))
  }

  // Complete lines from offset on, at most about MAX_READ_BYTES of them. An
  // offset past the end or off a line boundary means the ledger was replaced
  // (a recreated workspace), so reading restarts from 0.
  async read(offset: number): Promise<{ records: UsageRecord[]; offset: number; more: boolean }> {
    await this.tail
    let fh: fs.FileHandle
    try {
      fh = await fs.open(this.file, 'r')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], offset: 0, more: false }
      throw err
    }
    try {
      const { size } = await fh.stat()
      if (offset > size) offset = 0
      if (offset > 0) {
        const prev = Buffer.alloc(1)
        await fh.read(prev, 0, 1, offset - 1)
        if (prev[0] !== 0x0a) offset = 0
      }
      const length = Math.min(size - offset, MAX_READ_BYTES)
      const buf = Buffer.alloc(length)
      if (length) await fh.read(buf, 0, length, offset)
      const end = buf.lastIndexOf(0x0a) + 1
      const records: UsageRecord[] = []
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line) continue
        try { records.push(JSON.parse(line) as UsageRecord) } catch { /* torn line: skip */ }
      }
      return { records, offset: offset + end, more: offset + end < size && end > 0 }
    } finally {
      await fh.close()
    }
  }
}
