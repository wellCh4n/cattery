"use client"

import { useState, useEffect, useRef } from "react"
import {
  Bot,
  User as UserIcon,
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
import { getSession, getHistory, abortSession, type Session, type Agent } from "@/lib/api"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

interface PlatformEvent {
  type: "message.delta" | "tool.start" | "tool.done" | "session.idle" | "session.error"
  data: MessageDeltaData | ToolStartData | ToolDoneData | SessionErrorData | Record<string, never>
}

interface MessageDeltaData  { partId: string; text: string }
interface ToolStartData     { toolId: string; tool: string; input?: string }
interface ToolDoneData      { toolId: string; tool: string; output?: string }
interface SessionErrorData  { message: string }

interface Bubble {
  id: string
  role: "user" | "assistant"
  kind: "text" | "tool" | "error"
  content: string
  toolName?: string
  toolStatus?: "pending" | "running" | "completed"
  toolOutput?: string
  done: boolean
}

interface Props {
  session: Session
  agent: Agent
  onSessionUpdate: (s: Session) => void
}

export function ChatPanel({ session: initialSession, agent, onSessionUpdate }: Props) {
  const [session, setSession] = useState(initialSession)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(initialSession.session_id)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    setSession(initialSession)
    setBubbles([])
    setInput("")
    setSending(false)
    sessionIdRef.current = initialSession.session_id
  }, [initialSession.session_id, initialSession])

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
            const d = ev.data as { toolId?: string; output?: string }
            if (!d.toolId) continue
            const existing = restored.find(b => b.id === d.toolId)
            if (existing) {
              existing.toolStatus = "completed"
              existing.toolOutput = d.output ?? ""
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

  useEffect(() => {
    if (session.status !== "creating") return
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      if (sessionIdRef.current !== session.session_id) return
      const s = await getSession(session.session_id)
      setSession(s)
      onSessionUpdate(s)
      if (s.status === "creating") timer = setTimeout(poll, 1500)
    }
    poll()
    return () => clearTimeout(timer)
  }, [session.session_id, session.status, onSessionUpdate])

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
          const next = prev.map(b =>
            b.kind === "text" && !b.done ? { ...b, done: true } : b
          )
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
            ? { ...b, toolStatus: "completed", toolOutput: d.output ?? "", done: true }
            : b
        ))
        break
      }

      case "session.idle": {
        setSending(false)
        setBubbles(prev => prev.map((b, i) =>
          i === prev.length - 1 && !b.done ? { ...b, done: true } : b
        ))
        break
      }

      case "session.error": {
        const d = ev.data as SessionErrorData
        setSending(false)
        setBubbles(prev => [...prev, {
          id: `err-${Date.now()}`,
          role: "assistant",
          kind: "error",
          content: d.message,
          done: true,
        }])
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
    setBubbles(prev => prev.map(b => b.done ? b : { ...b, done: true }))
  }

  async function handleSend() {
    if (!input.trim() || sending) return
    setSending(true)
    const text = input.trim()
    setInput("")

    setBubbles(prev => [...prev, {
      id: `user-${Date.now()}`,
      role: "user",
      kind: "text",
      content: text,
      done: true,
    }])

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
          {session.phase ?? session.status}
        </Badge>
        {sending && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            <span>thinking…</span>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {session.status === "creating" && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Starting sandbox… {session.phase ?? ""}</span>
            </div>
          )}
          {session.status === "failed" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <span>Failed at phase: {session.phase}</span>
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
              if (e.key === "Enter" && !e.shiftKey) {
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
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] min-w-0 rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40">
            <ToolStatusIcon status={bubble.toolStatus} />
            <Wrench className="size-3 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs font-semibold">{bubble.toolName}</span>
            {bubble.content && (
              <span className="font-mono text-xs text-muted-foreground truncate">
                {bubble.content}
              </span>
            )}
          </div>
          {bubble.toolOutput && (
            <pre className="max-h-40 overflow-y-auto px-3 py-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap border-t">
              {bubble.toolOutput}
            </pre>
          )}
        </div>
      </div>
    )
  }

  if (bubble.role === "user") {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[75%] rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
          {bubble.content}
        </div>
        <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
          <UserIcon className="size-3.5 text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start gap-2">
      <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="size-3.5 text-primary" />
      </div>
      <div className="max-w-[85%] min-w-0 rounded-2xl bg-muted px-4 py-2.5">
        <Markdown>{bubble.content}</Markdown>
        {!bubble.done && (
          <span className="inline-block w-1.5 h-3.5 bg-current animate-pulse ml-0.5 align-text-bottom rounded-[1px]" />
        )}
      </div>
    </div>
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
