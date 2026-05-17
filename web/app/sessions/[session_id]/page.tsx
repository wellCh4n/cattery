"use client"

import { useState, useEffect, useRef, use } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { getSession, sendMessage, type Session } from "@/lib/api"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

// 平台统一事件格式
interface PlatformEvent {
  type: "message.delta" | "tool.start" | "tool.done" | "session.idle" | "session.error"
  data: MessageDeltaData | ToolStartData | ToolDoneData | SessionErrorData | Record<string, never>
}

interface MessageDeltaData { text: string }
interface ToolStartData   { tool: string; input?: string }
interface ToolDoneData    { tool: string; output?: string }
interface SessionErrorData { message: string }

export default function SessionPage({ params }: { params: Promise<{ session_id: string }> }) {
  const { session_id } = use(params)
  const [session, setSession] = useState<Session | null>(null)
  const [events, setEvents] = useState<PlatformEvent[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // poll until ready
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const sess = await getSession(session_id)
      setSession(sess)
      if (sess.status === "creating") {
        timer = setTimeout(poll, 1500)
      }
    }
    poll()
    return () => clearTimeout(timer)
  }, [session_id])

  async function handleSend() {
    if (!input.trim() || sending) return
    setSending(true)
    const text = input.trim()
    setInput("")

    try {
      // 1. 发送消息（SSE 响应）
      const res = await fetch(`${API_BASE}/api/v1/sessions/${session_id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      if (!res.ok || !res.body) return

      // 2. 用 ReadableStream 逐行解析 SSE
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        // SSE 事件以 \n\n 分隔
        const blocks = buf.split("\n\n")
        buf = blocks.pop() ?? ""

        for (const block of blocks) {
          let dataLine = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) {
              dataLine = line.slice(5).trim()
            }
          }
          if (!dataLine) continue
          try {
            const ev: PlatformEvent = JSON.parse(dataLine)
            setEvents(prev => [...prev, ev])
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
          } catch { /* ignore */ }
        }
      }
    } finally {
      setSending(false)
    }
  }

  function statusColor(status: string) {
    if (status === "ready") return "default"
    if (status === "failed") return "destructive"
    return "secondary"
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b px-6 py-3 flex items-center gap-3">
        <a href="/" className="text-sm text-muted-foreground hover:underline">← Agents</a>
        <span className="text-sm font-mono text-muted-foreground">{session_id.slice(0, 8)}…</span>
        {session && (
          <Badge variant={statusColor(session.status)}>
            {session.phase ?? session.status}
          </Badge>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {events.length === 0 && session?.status === "ready" && (
          <p className="text-sm text-muted-foreground">Session ready. Send a message to start.</p>
        )}
        {session?.status === "creating" && (
          <p className="text-sm text-muted-foreground animate-pulse">
            Starting sandbox… {session.phase ?? ""}
          </p>
        )}
        {session?.status === "failed" && (
          <p className="text-sm text-red-500">Session failed. Phase: {session.phase}</p>
        )}
        {events.map((ev, i) => <EventRow key={i} event={ev} />)}
        <div ref={bottomRef} />
      </div>

      <div className="border-t px-6 py-4 flex gap-3">
        <Textarea
          className="flex-1 resize-none"
          rows={2}
          placeholder="Send a message…"
          value={input}
          disabled={session?.status !== "ready" || sending}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <Button
          disabled={session?.status !== "ready" || sending || !input.trim()}
          onClick={handleSend}
          className="self-end"
        >
          {sending ? "…" : "Send"}
        </Button>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: PlatformEvent }) {
  switch (event.type) {
    case "message.delta": {
      const d = event.data as MessageDeltaData
      return (
        <div className="rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap">
          {d.text}
        </div>
      )
    }
    case "tool.start": {
      const d = event.data as ToolStartData
      return (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-mono text-blue-700">
          ▶ {d.tool}
          {d.input && <pre className="mt-1 text-xs opacity-70">{d.input}</pre>}
        </div>
      )
    }
    case "tool.done": {
      const d = event.data as ToolDoneData
      return (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-xs font-mono text-green-700">
          ✓ {d.tool}
          {d.output && <pre className="mt-1 text-xs opacity-70 max-h-32 overflow-auto">{d.output}</pre>}
        </div>
      )
    }
    case "session.idle":
      return <div className="text-xs text-muted-foreground text-center py-1">— done —</div>
    case "session.error": {
      const d = event.data as SessionErrorData
      return <div className="text-xs text-red-500 px-4 py-2">{d.message}</div>
    }
    default:
      return null
  }
}
