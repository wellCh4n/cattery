"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAppsStore } from "@/lib/apps-store"
import { NewPortDetector } from "@/lib/new-ports"
import { notify } from "@/lib/notify"

// Loads the open project's sandbox servers whatever the sidebar shows (the live
// channel pushes later changes), and toasts when one starts listening. Keyed
// by project, so switching projects starts a fresh baseline.
export function AppWatcher({ projectId }: { projectId: string }) {
  const router = useRouter()
  const load = useAppsStore(s => s.load)
  const apps = useAppsStore(s => (s.projectId === projectId ? s.apps : null))
  const readAt = useAppsStore(s => s.readAt)
  const detector = useRef(new NewPortDetector())

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])

  useEffect(() => {
    if (!apps) return
    for (const app of detector.current.next(apps, readAt)) {
      notify(`Port ${app.port} is running`, {
        id: `app-${projectId}-${app.port}`,
        // Sonner holds the timer while the tab is hidden, so a server started
        // while away still shows for the full 5 s on return.
        duration: 5000,
        closeButton: true,
        description: app.command,
        action: { label: "Open", onClick: () => router.push(`/ports/${projectId}/${app.port}`) },
      })
    }
  }, [apps, readAt, projectId, router])

  return null
}
