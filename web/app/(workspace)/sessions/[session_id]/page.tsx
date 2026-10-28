"use client"

import { use, useEffect, useState } from "react"
import { AlertTriangle, Loader2, Trash2 } from "lucide-react"
import { ChatPanel } from "@/components/chat-panel"
import { SessionNotFoundError } from "@/lib/api"
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
  // Which session was found deleted, so the notice does not follow this page
  // component over to another session.
  const [deletedId, setDeletedId] = useState<string | null>(null)
  const deleted = deletedId === session_id
  const missing = session === null

  useDocumentTitle(session ? (session.title ?? "New Session") : null)

  // Load a session opened directly (not yet in the workspace store). Depends on
  // whether it is present, not on the session object, which every refresh replaces.
  useEffect(() => {
    if (!missing) return
    let cancelled = false
    refreshSession(session_id).catch(e => {
      if (cancelled) return
      // Deleted, here or by another member: the tab stays where it is and the
      // pane shows only a notice.
      if (e instanceof SessionNotFoundError) setDeletedId(session_id)
      else setError(e instanceof Error ? e.message : "Failed to load session")
    })
    return () => { cancelled = true }
  }, [missing, refreshSession, session_id])

  if (deleted) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <Trash2 className="size-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">This session has been deleted</p>
      </div>
    )
  }

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

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return <ChatPanel key={session.session_id} session={session} />
}
