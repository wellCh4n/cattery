"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
  }, [initialSession.session_id])

  // load history when session becomes ready
  useEffect(() => {
    if (session.status !== "ready") return
    let cancelled = false
    getHistory(session.session_id).then(items => {
      if (cancelled || sessionIdRef.current !== session.session_id) return
      const restored: Bubble[] = []
      for (const item of items) {
        if (item.role === "user") {
          // 用户消息：合并 events 里所有 text
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
        // assistant 消息：按 events 还原
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
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [session.session_id, session.status])

  // poll until ready
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
        // 关闭未完成的 text bubble；按 toolId 创建/更新工具 bubble
        setBubbles(prev => {
          const next = prev.map(b =>
            b.kind === "text" && !b.done ? { ...b, done: true } : b
          )
          const existing = next.find(b => b.id === d.toolId)
          if (existing) {
            // 同一 toolId 重复 start（input 在更新），刷新 input 即可
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
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-2 flex items-center gap-3 shrink-0">
        <span className="text-sm font-medium truncate">{agent.agent_name ?? "Untitled"}</span>
        <span className="text-xs text-muted-foreground font-mono">{session.session_id.slice(0, 8)}…</span>
        <Badge variant={statusVariant(session.status)} className="text-xs">
          {session.phase ?? session.status}
        </Badge>
        {sending && <span className="text-xs text-muted-foreground animate-pulse ml-auto">thinking…</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {session.status === "creating" && (
          <p className="text-sm text-muted-foreground animate-pulse">
            Starting sandbox… {session.phase ?? ""}
          </p>
        )}
        {session.status === "failed" && (
          <p className="text-sm text-red-500">Failed at phase: {session.phase}</p>
        )}
        {session.status === "ready" && bubbles.length === 0 && (
          <p className="text-sm text-muted-foreground">Session ready. Send a message to start.</p>
        )}
        {bubbles.map((b) => <BubbleRow key={b.id} bubble={b} />)}
        <div ref={bottomRef} />
      </div>

      <div className="border-t px-4 py-3 flex gap-2 shrink-0">
        <Textarea
          className="flex-1 resize-none"
          rows={2}
          placeholder="Send a message… (Enter to send, Shift+Enter for newline)"
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
          <Button
            className="self-end"
            variant="destructive"
            onClick={handleStop}
          >
            Stop
          </Button>
        ) : (
          <Button
            className="self-end"
            disabled={session.status !== "ready" || !input.trim()}
            onClick={handleSend}
          >
            Send
          </Button>
        )}
      </div>
    </div>
  )
}

function BubbleRow({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-600 whitespace-pre-wrap">
        {bubble.content}
      </div>
    )
  }

  if (bubble.kind === "tool") {
    const statusColor =
      bubble.toolStatus === "completed" ? "text-green-600" :
      bubble.toolStatus === "running" ? "text-yellow-600 animate-pulse" :
      "text-muted-foreground"
    const statusIcon =
      bubble.toolStatus === "completed" ? "✓" :
      bubble.toolStatus === "running" ? "▶" : "○"
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-xl border bg-card px-3 py-2 text-xs font-mono">
          <div className="flex items-center gap-1.5">
            <span className={statusColor}>{statusIcon}</span>
            <span className="font-semibold text-muted-foreground">{bubble.toolName}</span>
            {bubble.content && <span className="text-muted-foreground truncate">{bubble.content}</span>}
          </div>
          {bubble.toolOutput && (
            <pre className="mt-1 max-h-32 overflow-y-auto text-[11px] text-muted-foreground whitespace-pre-wrap border-t pt-1">
              {bubble.toolOutput}
            </pre>
          )}
        </div>
      </div>
    )
  }

  if (bubble.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-2xl bg-primary text-primary-foreground px-4 py-2 text-sm whitespace-pre-wrap">
          {bubble.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm whitespace-pre-wrap">
        {bubble.content}
        {!bubble.done && <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 align-text-bottom" />}
      </div>
    </div>
  )
}
