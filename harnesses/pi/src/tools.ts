/**
 * Coding tools for the pi agent. pi-agent-core ships the loop but no tools, so
 * the harness owns them — which also lets each tool attach a `details` payload
 * shaped for the frontend's rich renderers (see ParsedFileRead / ParsedGlob in
 * backend/internal/harness/event.go). The `details` value is forwarded to the
 * platform as `tool.done.parsed`.
 *
 * Tool names and argument keys are part of the platform contract: the chat
 * panel's formatToolInput() keys on them.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static, type TSchema } from 'typebox'

const READ_DEFAULT_LIMIT = 2000
const READ_MAX_LINE_CHARS = 2000
const OUTPUT_MAX_CHARS = 30_000
const BASH_DEFAULT_TIMEOUT_S = 120
const BASH_MAX_TIMEOUT_S = 600
const SEARCH_MAX_RESULTS = 500

interface FileLine { n: number; text: string }
interface ParsedFileRead { path: string; fileType: 'file' | 'directory'; lines: FileLine[]; totalLines: number }
interface ParsedGlob { paths: string[] }

function text(t: string, details: unknown = null): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: t }], details }
}

function truncate(s: string): string {
  if (s.length <= OUTPUT_MAX_CHARS) return s
  const dropped = s.length - OUTPUT_MAX_CHARS
  return `[… ${dropped} chars truncated …]\n` + s.slice(-OUTPUT_MAX_CHARS)
}

// Typed constructor so `params` in execute() is inferred from the schema.
function tool<P extends TSchema>(def: Omit<AgentTool<P>, 'execute'> & {
  execute: (params: Static<P>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>
}): AgentTool<P> {
  return { ...def, execute: (_id, params, signal) => def.execute(params, signal) }
}

interface ExecResult { code: number | null; out: string; timedOut: boolean }

function exec(cmd: string, args: string[], cwd: string, opts: { timeoutS?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = ''
    let timedOut = false
    const onData = (b: Buffer) => {
      out += b.toString('utf8')
      // Keep memory bounded on chatty commands; only the tail is returned.
      if (out.length > OUTPUT_MAX_CHARS * 4) out = out.slice(-OUTPUT_MAX_CHARS * 2)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    // detached + negative pid kills the whole process group, so `sleep` in a
    // pipeline doesn't outlive an abort.
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ } }
    const timer = opts.timeoutS ? setTimeout(() => { timedOut = true; kill() }, opts.timeoutS * 1000) : null
    opts.signal?.addEventListener('abort', kill, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', kill)
      resolve({ code, out, timedOut })
    })
  })
}

export function createTools(workdir: string): AgentTool<any>[] {
  const resolve = (p: string | undefined) => path.resolve(workdir, p || '.')

  const read = tool({
    name: 'read',
    label: 'Read',
    description:
      `Read a file (or list a directory). Output lines are prefixed with line numbers. ` +
      `Reads up to ${READ_DEFAULT_LIMIT} lines by default; use offset/limit for large files.`,
    parameters: Type.Object({
      path: Type.String({ description: 'File path, absolute or relative to the workspace' }),
      offset: Type.Optional(Type.Number({ description: '1-based line to start from' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
    }),
    async execute({ path: p, offset, limit }) {
      const abs = resolve(p)
      const st = await fs.stat(abs)
      if (st.isDirectory()) {
        const entries = await fs.readdir(abs, { withFileTypes: true })
        const names = entries.map(e => e.name + (e.isDirectory() ? '/' : '')).sort()
        const parsed: ParsedFileRead = {
          path: abs, fileType: 'directory',
          lines: names.map((t, i) => ({ n: i + 1, text: t })), totalLines: names.length,
        }
        return text(names.join('\n') || '(empty directory)', parsed)
      }
      const buf = await fs.readFile(abs)
      if (buf.subarray(0, 8000).includes(0)) throw new Error(`${abs} looks like a binary file`)
      const all = buf.toString('utf8').split('\n')
      if (all.length > 1 && all[all.length - 1] === '') all.pop()
      const start = Math.max(1, Math.floor(offset ?? 1))
      const count = Math.max(1, Math.floor(limit ?? READ_DEFAULT_LIMIT))
      const lines: FileLine[] = all.slice(start - 1, start - 1 + count).map((t, i) => ({
        n: start + i,
        text: t.length > READ_MAX_LINE_CHARS ? t.slice(0, READ_MAX_LINE_CHARS) + '…' : t,
      }))
      let body = lines.map(l => `${String(l.n).padStart(6)}\t${l.text}`).join('\n')
      const last = start - 1 + lines.length
      if (last < all.length) body += `\n\n[showing lines ${start}-${last} of ${all.length}; use offset to read more]`
      const parsed: ParsedFileRead = { path: abs, fileType: 'file', lines, totalLines: all.length }
      return text(body || '(empty file)', parsed)
    },
  })

  const write = tool({
    name: 'write',
    label: 'Write',
    description: 'Create or overwrite a file with the given content. Parent directories are created as needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path, absolute or relative to the workspace' }),
      content: Type.String({ description: 'Full file content' }),
    }),
    executionMode: 'sequential',
    async execute({ path: p, content }) {
      const abs = resolve(p)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
      return text(`Wrote ${Buffer.byteLength(content)} bytes to ${abs}`)
    },
  })

  const edit = tool({
    name: 'edit',
    label: 'Edit',
    description:
      'Edit a file by exact string replacement. Each oldText must match exactly once in the file ' +
      '(include surrounding lines to make it unique). Edits are applied in order.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path, absolute or relative to the workspace' }),
      edits: Type.Array(Type.Object({
        oldText: Type.String({ description: 'Exact text to replace' }),
        newText: Type.String({ description: 'Replacement text' }),
      }), { minItems: 1 }),
    }),
    executionMode: 'sequential',
    async execute({ path: p, edits }) {
      const abs = resolve(p)
      let content = await fs.readFile(abs, 'utf8')
      edits.forEach(({ oldText, newText }, i) => {
        const at = content.indexOf(oldText)
        if (!oldText || at < 0) throw new Error(`edit ${i + 1}: oldText not found in ${abs}`)
        if (content.indexOf(oldText, at + 1) >= 0) {
          throw new Error(`edit ${i + 1}: oldText matches more than once in ${abs}; add context to make it unique`)
        }
        content = content.slice(0, at) + newText + content.slice(at + oldText.length)
      })
      await fs.writeFile(abs, content, 'utf8')
      return text(`Applied ${edits.length} edit(s) to ${abs}`)
    },
  })

  const bash = tool({
    name: 'bash',
    label: 'Bash',
    description:
      `Run a shell command with bash in the workspace directory. stdout and stderr are combined. ` +
      `Default timeout ${BASH_DEFAULT_TIMEOUT_S}s, max ${BASH_MAX_TIMEOUT_S}s. Long output is truncated to the tail.`,
    parameters: Type.Object({
      command: Type.String({ description: 'Command to run' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
    }),
    async execute({ command, timeout }, signal) {
      const timeoutS = Math.min(Math.max(1, timeout ?? BASH_DEFAULT_TIMEOUT_S), BASH_MAX_TIMEOUT_S)
      const r = await exec('bash', ['-lc', command], workdir, { timeoutS, signal })
      let out = truncate(r.out.trimEnd())
      if (r.timedOut) out += `\n[timed out after ${timeoutS}s]`
      if (r.code !== 0) {
        throw new Error(`${out}\n[exit code ${r.code ?? 'killed'}]`.trim())
      }
      return text(out || '(no output)')
    },
  })

  const grep = tool({
    name: 'grep',
    label: 'Grep',
    description: 'Search file contents with a regular expression (ripgrep). Respects .gitignore. Returns path:line:text.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression' }),
      path: Type.Optional(Type.String({ description: 'Directory or file to search; defaults to the workspace' })),
      glob: Type.Optional(Type.String({ description: 'Only search files matching this glob, e.g. "*.ts"' })),
      ignoreCase: Type.Optional(Type.Boolean()),
    }),
    async execute({ pattern, path: p, glob, ignoreCase }, signal) {
      const args = ['-n', '--no-heading', '--color=never', '-m', '50']
      if (ignoreCase) args.push('-i')
      if (glob) args.push('-g', glob)
      args.push('-e', pattern, resolve(p))
      const r = await exec('rg', args, workdir, { timeoutS: 60, signal })
      if (r.code === 1) return text('No matches')
      if (r.code !== 0) throw new Error(r.out.trim() || `rg exited with ${r.code}`)
      const lines = r.out.trimEnd().split('\n')
      const shown = lines.slice(0, SEARCH_MAX_RESULTS)
      let body = shown.join('\n')
      if (lines.length > shown.length) body += `\n[${lines.length - shown.length} more matches omitted]`
      return text(truncate(body))
    },
  })

  const globTool = tool({
    name: 'glob',
    label: 'Glob',
    description: 'Find files by glob pattern (e.g. "**/*.go"). Respects .gitignore. Returns matching paths.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern' }),
      path: Type.Optional(Type.String({ description: 'Directory to search; defaults to the workspace' })),
    }),
    async execute({ pattern, path: p }, signal) {
      const root = resolve(p)
      const r = await exec('rg', ['--files', '--color=never', '-g', pattern, root], workdir, { timeoutS: 60, signal })
      if (r.code !== 0 && r.code !== 1) throw new Error(r.out.trim() || `rg exited with ${r.code}`)
      const all = r.out.split('\n').filter(Boolean).sort()
      const paths = all.slice(0, SEARCH_MAX_RESULTS)
      const parsed: ParsedGlob = { paths }
      let body = paths.join('\n') || 'No files found'
      if (all.length > paths.length) body += `\n[${all.length - paths.length} more files omitted]`
      return text(body, parsed)
    },
  })

  const ls = tool({
    name: 'ls',
    label: 'List',
    description: 'List a directory. Directories are suffixed with "/".',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory; defaults to the workspace' })),
    }),
    async execute({ path: p }) {
      const abs = resolve(p)
      const entries = await fs.readdir(abs, { withFileTypes: true })
      const names = entries.map(e => e.name + (e.isDirectory() ? '/' : '')).sort()
      return text(names.join('\n') || '(empty directory)')
    },
  })

  return [read, write, edit, bash, grep, globTool, ls]
}
