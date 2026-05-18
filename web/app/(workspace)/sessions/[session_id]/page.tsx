"use client"

import { use, useEffect, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { ChatPanel } from "@/components/chat-panel"
import { TerminalView } from "@/components/terminal-view"
import { getSession, listAgents, type Agent, type Session } from "@/lib/api"

interface PageParams {
  session_id: string
}

export default function SessionPage({ params }: { params: Promise<PageParams> }) {
  const { session_id } = use(params)
  const [data, setData] = useState<{ session: Session; agent: Agent } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    setData(null)
    setError(null)

    async function load() {
      try {
        const session = await getSession(session_id)
        const agents = await listAgents()
        const agent = agents.find(a => a.agent_id === session.agent_id)
        if (cancelled) return
        if (!agent) {
          setError("Agent not found for this session.")
          return
        }
        setData({ session, agent })
        if (session.status === "creating") timer = setTimeout(poll, 1500)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load session")
      }
    }

    async function poll() {
      if (cancelled) return
      try {
        const session = await getSession(session_id)
        if (cancelled) return
        setData(prev => (prev ? { ...prev, session } : prev))
        if (session.status === "creating") timer = setTimeout(poll, 1500)
      } catch { /* ignore transient errors */ }
    }

    load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [session_id])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center px-6">
        <div className="rounded-full bg-destructive/10 p-4 mb-4">
          <AlertTriangle className="size-7 text-destructive" />
        </div>
        <p className="text-sm font-medium">{error}</p>
        <p className="text-xs text-muted-foreground mt-1">Session id: {session_id}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return data.agent.harness_kind === "terminal" ? (
    <TerminalView
      key={data.session.session_id}
      session={data.session}
      agent={data.agent}
    />
  ) : (
    <ChatPanel
      key={data.session.session_id}
      session={data.session}
      agent={data.agent}
    />
  )
}
