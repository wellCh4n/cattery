"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { getSession, sendMessage, type Session, type Agent } from "@/lib/api"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

// opencode SSE event — all events share {id, type, properties}
interface OpenCodeEvent {
  id: string
  type: string
  properties: {
    sessionID?: string
    delta?: string       // session.next.text.delta
    text?: string        // session.next.text.ended / session.next.synthetic
    command?: string     // session.next.shell.started
    output?: string      // session.next.shell.ended
    callID?: string
    error?: unknown      // session.error
    [key: string]: unknown
  }
}

// A rendered chat bubble
interface Bubble {
  id: string
  kind: "text" | "tool" | "error" | "other"
  content: string
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
  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef(initialSession.session_id)
  // accumulate text delta per opencode "text block" (one per assistant turn)
  const textBubbleRef = useRef<string | null>(null)

  useEffect(() => {
    setSession(initialSession)
    setBubbles([])
    setInput("")
    textBubbleRef.current = null
    sessionIdRef.current = initialSession.session_id
  }, [initialSession.session_id])

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

  // SSE stream when ready
  useEffect(() => {
    if (session.status !== "ready") return
    esRef.current?.close()
    const es = new EventSource(`${API_BASE}/api/v1/sessions/${session.session_id}/stream`)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const ev: OpenCodeEvent = JSON.parse(e.data)
        handleEvent(ev)
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
      } catch { /* ignore parse errors */ }
    }
    return () => es.close()
  }, [session.status, session.session_id])

  function handleEvent(ev: OpenCodeEvent) {
    switch (ev.type) {
      case "session.next.text.started":
        // begin a new text bubble
        textBubbleRef.current = ""
        setBubbles(prev => [...prev, {
          id: ev.id,
          kind: "text",
          content: "",
          done: false,
        }])
        break

      case "session.next.text.delta":
        if (ev.properties.delta) {
          textBubbleRef.current = (textBubbleRef.current ?? "") + ev.properties.delta
          const accumulated = textBubbleRef.current
          setBubbles(prev => {
            const last = prev[prev.length - 1]
            if (last && last.kind === "text" && !last.done) {
              return [...prev.slice(0, -1), { ...last, content: accumulated }]
            }
            return prev
          })
        }
        break

      case "session.next.text.ended":
        textBubbleRef.current = null
        setBubbles(prev => {
          const last = prev[prev.length - 1]
          if (last && last.kind === "text" && !last.done) {
            return [...prev.slice(0, -1), { ...last, done: true }]
          }
          return prev
        })
        break

      case "session.next.shell.started":
        setBubbles(prev => [...prev, {
          id: ev.id,
          kind: "tool",
          content: `$ ${ev.properties.command ?? ""}`,
          done: false,
        }])
        break

      case "session.next.shell.ended":
        setBubbles(prev => prev.map(b =>
          b.kind === "tool" && !b.done
            ? { ...b, content: b.content + "\n" + (ev.properties.output ?? ""), done: true }
            : b
        ))
        break

      case "session.next.synthetic":
        setBubbles(prev => [...prev, {
          id: ev.id,
          kind: "text",
          content: ev.properties.text ?? "",
          done: true,
        }])
        break

      case "session.error":
        setBubbles(prev => [...prev, {
          id: ev.id,
          kind: "error",
          content: JSON.stringify(ev.properties.error ?? ev.properties),
          done: true,
        }])
        break

      case "session.idle":
        setSending(false)
        break

      default:
        // silently ignore other events (session.diff, session.status, etc.)
        break
    }
  }

  async function handleSend() {
    if (!input.trim() || sending) return
    setSending(true)
    const text = input.trim()
    setInput("")
    // show user bubble immediately
    setBubbles(prev => [...prev, {
      id: `user-${Date.now()}`,
      kind: "text",
      content: text,
      done: true,
    }])
    try {
      await sendMessage(session.session_id, text)
      // response arrives via SSE; sending stays true until session.idle
    } catch {
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
      {/* header */}
      <div className="border-b px-4 py-2 flex items-center gap-3 shrink-0">
        <span className="text-sm font-medium truncate">{agent.agent_name ?? "Untitled"}</span>
        <span className="text-xs text-muted-foreground font-mono">{session.session_id.slice(0, 8)}…</span>
        <Badge variant={statusVariant(session.status)} className="text-xs">
          {session.phase ?? session.status}
        </Badge>
        {sending && <span className="text-xs text-muted-foreground animate-pulse ml-auto">thinking…</span>}
      </div>

      {/* messages */}
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

      {/* input */}
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
        <Button
          className="self-end"
          disabled={session.status !== "ready" || sending || !input.trim()}
          onClick={handleSend}
        >
          {sending ? "…" : "Send"}
        </Button>
      </div>
    </div>
  )
}

function BubbleRow({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === "text") {
    return (
      <div className="rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap">
        {bubble.content}
        {!bubble.done && <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 align-text-bottom" />}
      </div>
    )
  }
  if (bubble.kind === "tool") {
    return (
      <div className="rounded-lg border bg-card px-4 py-3 text-xs font-mono text-muted-foreground whitespace-pre-wrap">
        {bubble.content}
        {!bubble.done && <span className="text-yellow-500"> ▶</span>}
      </div>
    )
  }
  if (bubble.kind === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-600 whitespace-pre-wrap">
        {bubble.content}
      </div>
    )
  }
  return null
}

