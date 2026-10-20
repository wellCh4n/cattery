"use client"

import { use, useEffect, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { ChatPanel } from "@/components/chat-panel"
import { useDocumentTitle } from "@/lib/use-document-title"
import { findSession, useWorkspaceStore } from "@/lib/workspace-store"

interface PageParams {
  session_id: string
}

export default function SessionPage({ params }: { params: Promise<PageParams> }) {
  const { session_id } = use(params)
  const session = useWorkspaceStore(state => findSession(state.projects, session_id)?.session ?? null)
  const refreshSession = useWorkspaceStore(state => state.refreshSession)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(session === null)

  useDocumentTitle(session ? (session.title ?? "New Session") : null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(session === null)
      setError(null)
    })

    async function poll() {
      if (cancelled) return
      try {
        const session = await refreshSession(session_id)
        if (cancelled) return
        setLoading(false)
        if (session?.status === "creating") timer = setTimeout(poll, 1500)
      } catch (e) {
        if (!cancelled) {
          setLoading(false)
          setError(e instanceof Error ? e.message : "Failed to load session")
        }
      }
    }

    if (!session || session.status === "creating") void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [refreshSession, session, session_id])

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

  if (loading || !session) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return <ChatPanel key={session.session_id} session={session} />
}
