"use client"

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { useWorkspaceStore } from "@/lib/workspace-store"

// Forks a session (whole, or before the user message `before`) and opens the
// copy, which belongs to whoever forked it.
export function useForkSession() {
  const router = useRouter()
  const forkSession = useWorkspaceStore(state => state.forkSession)
  const [forking, setForking] = useState(false)
  const fork = useCallback(async (sessionId: string, before?: string) => {
    if (forking) return
    setForking(true)
    try {
      const session = await forkSession(sessionId, before)
      router.push(`/sessions/${session.session_id}`)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to fork session")
    } finally {
      setForking(false)
    }
  }, [forkSession, forking, router])
  return { fork, forking }
}
