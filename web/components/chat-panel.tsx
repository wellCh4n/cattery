"use client"

import { useState, useEffect, useRef } from "react"
import {
  Bot,
  Send,
  Square,
  Loader2,
  CheckCircle2,
  CircleAlert,
  Wrench,
  Sparkles,
  AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Markdown } from "@/components/markdown"
import { FileViewer } from "@/components/file-viewer"
import { getHistory, abortSession, type Session, type Agent } from "@/lib/api"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

interface PlatformEvent {
  type: "message.delta" | "tool.start" | "tool.done" | "session.idle" | "session.error" | "session.title"
  data: MessageDeltaData | ToolStartData | ToolDoneData | SessionErrorData | SessionTitleData | Record<string, never>
}

interface MessageDeltaData  { partId: string; text: string }
interface ToolStartData     { toolId: string; tool: string; input?: string }
interface ToolDoneData      { toolId: string; tool: string; output?: string; parsed?: unknown }
interface SessionErrorData  { message: string }
interface SessionTitleData  { title: string }

interface ParsedFileRead {
  path: string
  fileType: "file" | "directory"
  lines: { n: number; text: string }[]
  totalLines: number
}

interface ParsedGlob {
  paths: string[]
}

interface Bubble {
  id: string
  role: "user" | "assistant"
  kind: "text" | "tool" | "error"
  content: string
  toolName?: string
  toolStatus?: "pending" | "running" | "completed"
  toolOutput?: string
  toolParsed?: unknown
  done: boolean
}

interface Props {
  session: Session
  agent: Agent
}

export function ChatPanel({ session, agent }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(session.session_id)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("cattery:session-busy", {
      detail: { sessionId: session.session_id, busy: sending },
    }))
  }, [session.session_id, sending])

  useEffect(() => {
    abortRef.current?.abort()
    setBubbles([])
    setInput("")
    setSending(false)
    sessionIdRef.current = session.session_id
  }, [session.session_id])

  useEffect(() => {
    if (session.status !== "ready") return
    let cancelled = false
    getHistory(session.session_id).then(items => {
      if (cancelled || sessionIdRef.current !== session.session_id) return
      const restored: Bubble[] = []
      for (const item of items) {
        if (item.role === "user") {
          const text = item.events
            .filter(e => e.type === "message.delta")
            .map(e => (e.data as { text?: string }).text ?? "")
            .join("")
          if (text) {
            restored.push({
              id: item.messageId,
              role: "user",
              kind: "text",
              content: text,
              done: true,
            })
          }
          continue
        }
        for (const ev of item.events) {
          if (ev.type === "message.delta") {
            const d = ev.data as { partId?: string; text?: string }
            if (!d.partId || !d.text) continue
            const existing = restored.find(b => b.id === d.partId)
            if (existing) {
              existing.content = d.text
            } else {
              restored.push({
                id: d.partId,
                role: "assistant",
                kind: "text",
                content: d.text,
                done: true,
              })
            }
          } else if (ev.type === "tool.start") {
            const d = ev.data as { toolId?: string; tool?: string; input?: string }
            if (!d.toolId) continue
            if (!restored.find(b => b.id === d.toolId)) {
              restored.push({
                id: d.toolId,
                role: "assistant",
                kind: "tool",
                content: d.input ?? "",
                toolName: d.tool,
                toolStatus: "running",
                done: false,
              })
            }
          } else if (ev.type === "tool.done") {
            const d = ev.data as { toolId?: string; output?: string; parsed?: ParsedFileRead }
            if (!d.toolId) continue
            const existing = restored.find(b => b.id === d.toolId)
            if (existing) {
              existing.toolStatus = "completed"
              existing.toolOutput = d.output ?? ""
              existing.toolParsed = d.parsed
              existing.done = true
            }
          }
        }
      }
      setBubbles(restored)
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "auto" })
      })
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [session.session_id, session.status])

  function handleEvent(ev: PlatformEvent) {
    switch (ev.type) {
      case "message.delta": {
        const d = ev.data as MessageDeltaData
        if (!d.text || !d.partId) break
        const partID = d.partId
        const delta = d.text
        setBubbles(prev => {
          const existing = prev.find(b => b.id === partID)
          if (existing) {
            return prev.map(b => b.id === partID ? { ...b, content: b.content + delta } : b)
          }
          const pendingIdx = prev.findIndex(b =>
            b.role === "assistant" && b.kind === "text" && !b.done && b.id.startsWith("pending-")
          )
          if (pendingIdx >= 0) {
            return prev.map((b, i) => i === pendingIdx ? { ...b, id: partID, content: delta } : b)
          }
          return [...prev, {
            id: partID,
            role: "assistant",
            kind: "text",
            content: delta,
            done: false,
          }]
        })
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
        break
      }

      case "tool.start": {
        const d = ev.data as ToolStartData
        setBubbles(prev => {
          const next = prev
            .filter(b => !(b.kind === "text" && !b.done && b.content === ""))
            .map(b => b.kind === "text" && !b.done ? { ...b, done: true } : b)
          const existing = next.find(b => b.id === d.toolId)
          if (existing) {
            return next.map(b => b.id === d.toolId
              ? { ...b, content: d.input ?? b.content }
              : b
            )
          }
          return [...next, {
            id: d.toolId,
            role: "assistant",
            kind: "tool",
            content: d.input ?? "",
            toolName: d.tool,
            toolStatus: "running",
            done: false,
          }]
        })
        break
      }

      case "tool.done": {
        const d = ev.data as ToolDoneData
        setBubbles(prev => prev.map(b =>
          b.id === d.toolId
            ? { ...b, toolStatus: "completed", toolOutput: d.output ?? "", toolParsed: d.parsed, done: true }
            : b
        ))
        break
      }

      case "session.idle": {
        setSending(false)
        setBubbles(prev => prev
          .filter(b => !(b.kind === "text" && !b.done && b.content === ""))
          .map((b, i, arr) => i === arr.length - 1 && !b.done ? { ...b, done: true } : b)
        )
        break
      }

      case "session.title": {
        const d = ev.data as SessionTitleData
        if (d.title) {
          window.dispatchEvent(new CustomEvent("cattery:title", {
            detail: { sessionId: session.session_id, title: d.title },
          }))
        }
        break
      }

      case "session.error": {
        const d = ev.data as SessionErrorData
        setSending(false)
        setBubbles(prev => [
          ...prev.filter(b => !(b.kind === "text" && !b.done && b.content === "")),
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            kind: "error",
            content: d.message,
            done: true,
          },
        ])
        break
      }
    }
  }

  async function handleStop() {
    abortRef.current?.abort()
    try {
      await abortSession(session.session_id)
    } catch { /* ignore */ }
    setSending(false)
    setBubbles(prev => prev
      .filter(b => !(b.kind === "text" && !b.done && b.content === ""))
      .map(b => b.done ? b : { ...b, done: true })
    )
  }

  async function handleSend() {
    if (!input.trim() || sending) return
    setSending(true)
    const text = input.trim()
    setInput("")

    const ts = Date.now()
    setBubbles(prev => [
      ...prev,
      {
        id: `user-${ts}`,
        role: "user",
        kind: "text",
        content: text,
        done: true,
      },
      {
        id: `pending-${ts}`,
        role: "assistant",
        kind: "text",
        content: "",
        done: false,
      },
    ])

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const res = await fetch(`${API_BASE}/api/v1/sessions/${session.session_id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        setSending(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            handleEvent(JSON.parse(data) as PlatformEvent)
          } catch { /* ignore */ }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") setSending(false)
    } finally {
      abortRef.current = null
      setSending(false)
    }
  }

  function statusVariant(s: string): "default" | "secondary" | "destructive" {
    if (s === "ready") return "default"
    if (s === "failed") return "destructive"
    return "secondary"
  }

  function phaseLabel(phase: string | null): string {
    switch (phase) {
      case "handshake":       return "Connecting to agent"
      case "handshake_error": return "Failed to connect to agent"
      case "sandbox_error":   return "Sandbox failed to start"
      default:                return phase ?? ""
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="border-b px-4 h-12 flex items-center gap-3 shrink-0">
        <Bot className="size-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{agent.agent_name ?? "Untitled"}</span>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {session.session_id.slice(0, 8)}
          </span>
        </div>
        <Badge variant={statusVariant(session.status)} className="text-[10px] h-5">
          {session.status}
        </Badge>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {session.status === "creating" && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Starting sandbox… {phaseLabel(session.phase)}</span>
            </div>
          )}
          {session.status === "failed" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <span>{phaseLabel(session.phase)}</span>
            </div>
          )}
          {session.status === "ready" && bubbles.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <div className="rounded-full bg-muted p-3 mb-3">
                <Sparkles className="size-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Session ready</p>
              <p className="text-xs text-muted-foreground mt-1">
                Send a message to start working with {agent.agent_name ?? "the agent"}.
              </p>
            </div>
          )}
          {bubbles.map((b) => <BubbleRow key={b.id} bubble={b} />)}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t bg-background px-4 md:px-8 py-3 shrink-0">
        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          <Textarea
            className="flex-1 resize-none min-h-[44px] max-h-48"
            rows={2}
            placeholder="Send a message…  (Enter to send · Shift+Enter for newline)"
            value={input}
            disabled={session.status !== "ready" || sending}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          {sending ? (
            <Button variant="destructive" size="icon-lg" onClick={handleStop} title="Stop">
              <Square />
            </Button>
          ) : (
            <Button
              size="icon-lg"
              disabled={session.status !== "ready" || !input.trim()}
              onClick={handleSend}
              title="Send"
            >
              <Send />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function BubbleRow({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === "error") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
        <CircleAlert className="size-4 shrink-0 mt-0.5" />
        <pre className="whitespace-pre-wrap font-mono leading-relaxed flex-1 min-w-0">
          {bubble.content}
        </pre>
      </div>
    )
  }

  if (bubble.kind === "tool") {
    const read = bubble.toolName === "read" ? (bubble.toolParsed as ParsedFileRead | undefined) : undefined
    const glob = bubble.toolName === "glob" ? (bubble.toolParsed as ParsedGlob | undefined) : undefined
    const header = formatToolInput(bubble.toolName, bubble.content)
    const primary = read?.path ?? header.primary
    const secondaryPath = header.path
    const primaryIsPath = !!read || bubble.toolName === "read" || bubble.toolName === "write" ||
                          bubble.toolName === "edit" || bubble.toolName === "list"
    const headerMeta =
      read ? `${read.totalLines} lines` :
      glob ? `${glob.paths.length} matches` :
      null

    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] min-w-[50%] rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40">
            <ToolStatusIcon status={bubble.toolStatus} />
            <Wrench className="size-3 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs font-semibold shrink-0">{bubble.toolName}</span>
            {primaryIsPath ? (
              <span
                dir="rtl"
                className="font-mono text-xs text-muted-foreground truncate min-w-0"
                title={primary}
              >
                <bdi>{primary}</bdi>
              </span>
            ) : (
              <span
                className="font-mono text-xs text-muted-foreground shrink-0"
                title={primary}
              >
                {primary}
              </span>
            )}
            {secondaryPath && (
              <span
                dir="rtl"
                className="font-mono text-xs text-muted-foreground/60 truncate min-w-0"
                title={secondaryPath}
              >
                <bdi>{secondaryPath}</bdi>
              </span>
            )}
            {headerMeta && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/60 shrink-0">
                {headerMeta}
              </span>
            )}
          </div>
          {read ? (
            <div className="max-h-64 overflow-y-auto border-t">
              <FileViewer path={read.path} lines={read.lines} />
            </div>
          ) : glob ? (
            <div className="max-h-64 overflow-y-auto border-t">
              <GlobMatches paths={glob.paths} />
            </div>
          ) : bubble.toolOutput ? (
            <pre className="max-h-40 overflow-y-auto px-3 py-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap border-t">
              {bubble.toolOutput}
            </pre>
          ) : null}
        </div>
      </div>
    )
  }

  if (bubble.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
          {bubble.content}
        </div>
      </div>
    )
  }

  const isThinking = !bubble.done && bubble.content === ""
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] min-w-[50%]">
        {isThinking ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>thinking…</span>
          </div>
        ) : (
          <>
            <Markdown>{bubble.content}</Markdown>
            {!bubble.done && (
              <span className="inline-block w-1.5 h-3.5 bg-current animate-pulse ml-0.5 align-text-bottom rounded-[1px]" />
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface ToolHeader {
  primary: string  // 主参数，显示在 tool 名之后
  path?: string    // 路径类参数，第二行显示
}

function formatToolInput(tool: string | undefined, raw: string): ToolHeader {
  if (!raw) return { primary: "" }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const str = (k: string) => typeof obj[k] === "string" ? (obj[k] as string) : undefined
    switch (tool) {
      case "glob":
      case "grep": {
        const pattern = str("pattern")
        if (pattern) return { primary: pattern, path: str("path") }
        break
      }
      case "read":
      case "write":
      case "edit": {
        const fp = str("filePath") ?? str("path")
        if (fp) return { primary: fp }
        break
      }
      case "list": {
        const p = str("path")
        if (p) return { primary: p }
        break
      }
      case "bash": {
        const cmd = str("command")
        if (cmd) return { primary: cmd }
        break
      }
      case "task": {
        const d = str("description") ?? str("prompt")
        if (d) return { primary: d }
        break
      }
    }
  } catch { /* fall through */ }
  return { primary: raw }
}

function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return ""
  if (paths.length === 1) {
    const i = paths[0].lastIndexOf("/")
    return i >= 0 ? paths[0].slice(0, i + 1) : ""
  }
  let prefix = paths[0]
  for (let i = 1; i < paths.length; i++) {
    while (prefix && !paths[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
    if (!prefix) return ""
  }
  const i = prefix.lastIndexOf("/")
  return i >= 0 ? prefix.slice(0, i + 1) : ""
}

function GlobMatches({ paths }: { paths: string[] }) {
  const prefix = commonDirPrefix(paths)
  return (
    <ul className="font-mono text-xs divide-y divide-border/40">
      {paths.map(p => {
        const rel = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p
        const idx = rel.lastIndexOf("/")
        const dir = idx >= 0 ? rel.slice(0, idx + 1) : ""
        const name = idx >= 0 ? rel.slice(idx + 1) : rel
        return (
          <li key={p} className="flex px-3 py-1 hover:bg-muted/30" title={p}>
            {dir && <span className="text-muted-foreground truncate min-w-0">{dir}</span>}
            <span className="text-foreground shrink-0 font-medium">{name}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ToolStatusIcon({ status }: { status?: "pending" | "running" | "completed" }) {
  if (status === "completed") {
    return <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
  }
  if (status === "running") {
    return <Loader2 className="size-3.5 text-amber-500 animate-spin shrink-0" />
  }
  return <Loader2 className="size-3.5 text-muted-foreground shrink-0" />
}
