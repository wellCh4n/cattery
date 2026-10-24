"use client"

import { create } from "zustand"
import { listApps, type SandboxApp } from "@/lib/api"

// Servers listening in the current project's sandbox. AppWatcher polls them
// for whichever project is open, so the Apps view and new-port toasts share
// one request loop.
interface AppsState {
  projectId: string | null
  apps: SandboxApp[] | null
  // When the list was read; running times count from it.
  readAt: number
  error: string | null
  refreshing: boolean
  load: (projectId: string) => Promise<void>
}

export const useAppsStore = create<AppsState>((set, get) => ({
  projectId: null,
  apps: null,
  readAt: 0,
  error: null,
  refreshing: false,
  load: async projectId => {
    if (get().projectId !== projectId) set({ projectId, apps: null, readAt: 0, error: null })
    set({ refreshing: true })
    try {
      const apps = await listApps(projectId)
      if (get().projectId === projectId) set({ apps, readAt: Date.now(), error: null })
    } catch (err) {
      if (get().projectId === projectId) set({ error: err instanceof Error ? err.message : "Failed to list apps" })
    } finally {
      if (get().projectId === projectId) set({ refreshing: false })
    }
  },
}))
