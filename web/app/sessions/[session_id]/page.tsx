"use client"

import { useState, useEffect, useRef, use } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { getSession, sendMessage, type Session } from "@/lib/api"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

interface MessagePart {
  type: string
  text?: string
  [key: string]: unknown
}

interface SSEEvent {
  type: string
  properties?: {
    sessionID?: string
    part?: MessagePart
    [key: string]: unknown
  }
}

export default function SessionPage({ params }: { params: Promise<{ session_id: string }> }) {
  const { session_id } = use(params)
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<SSEEvent[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

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

  // open SSE when ready
  useEffect(() => {
    if (session?.status !== "ready") return
    esRef.current?.close()
    const es = new EventSource(`${API_BASE}/api/v1/sessions/${session_id}/stream`)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const event: SSEEvent = JSON.parse(e.data)
        setMessages(prev => [...prev, event])
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
      } catch {
        // ignore
      }
    }
    return () => es.close()
  }, [session?.status, session_id])

  async function handleSend() {
    if (!input.trim() || sending) return
    setSending(true)
    try {
      await sendMessage(session_id, input.trim())
      setInput("")
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
      {/* header */}
      <div className="border-b px-6 py-3 flex items-center gap-3">
        <a href="/" className="text-sm text-muted-foreground hover:underline">← Agents</a>
        <span className="text-sm font-mono text-muted-foreground">{session_id.slice(0, 8)}…</span>
        {session && (
          <Badge variant={statusColor(session.status)}>
            {session.phase ?? session.status}
          </Badge>
        )}
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {messages.length === 0 && session?.status === "ready" && (
          <p className="text-sm text-muted-foreground">Session ready. Send a message to start.</p>
        )}
        {session?.status === "creating" && (
          <p className="text-sm text-muted-foreground animate-pulse">
            Starting sandbox… {session.phase ?? ""}
          </p>
        )}
        {session?.status === "failed" && (
          <p className="text-sm text-red-500">Session failed to start. Phase: {session.phase}</p>
        )}
        {messages.map((ev, i) => (
          <EventRow key={i} event={ev} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* input */}
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

function EventRow({ event }: { event: SSEEvent }) {
  const part = event.properties?.part
  if (!part) return null

  if (part.type === "text" && part.text) {
    return (
      <div className="rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap">
        {part.text}
      </div>
    )
  }

  return (
    <div className="rounded-lg border px-4 py-3 text-xs font-mono text-muted-foreground">
      <span className="font-semibold">{event.type}</span>{" "}
      {JSON.stringify(event.properties, null, 2)}
    </div>
  )
}
