"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAppsStore } from "@/lib/apps-store"
import { NewPortDetector } from "@/lib/new-ports"
import { notify } from "@/lib/notify"

// How often the open project's listening servers are re-read.
const POLL_MS = 3000

// Polls the open project's sandbox servers whatever the sidebar shows, and
// toasts when one starts listening. Keyed by project, so switching projects
// starts a fresh baseline.
export function AppWatcher({ projectId }: { projectId: string }) {
  const router = useRouter()
  const load = useAppsStore(s => s.load)
  const apps = useAppsStore(s => (s.projectId === projectId ? s.apps : null))
  const readAt = useAppsStore(s => s.readAt)
  const detector = useRef(new NewPortDetector())

  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void load(projectId) }
    tick()
    const timer = window.setInterval(tick, POLL_MS)
    document.addEventListener("visibilitychange", tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [projectId, load])

  useEffect(() => {
    if (!apps) return
    for (const app of detector.current.next(apps, readAt)) {
      notify(`Port ${app.port} is running`, {
        id: `app-${projectId}-${app.port}`,
        // Stays until closed, so a server started while away isn't missed.
        persistent: true,
        description: app.command,
        action: { label: "Open", onClick: () => router.push(`/ports/${projectId}/${app.port}`) },
      })
    }
  }, [apps, readAt, projectId, router])

  return null
}
