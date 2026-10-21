"use client"

// TerminalHost — draws started shells over the main pane. It lives in the
// workspace layout, not the /terminals route, so a shell keeps its connection
// and scrollback while other tabs are shown; only the routed one is visible.
// Ctrl+` jumps to the current project's newest terminal, creating one if needed.

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { TerminalView } from "@/components/terminal-view"
import { tabForPath } from "@/lib/tabs-store"
import { useTerminalStore } from "@/lib/terminal-store"
import { cn } from "@/lib/utils"
import { useWorkspaceStore } from "@/lib/workspace-store"

export function TerminalHost() {
  const router = useRouter()
  const pathname = usePathname()
  const terminals = useTerminalStore(state => state.terminals)
  const started = useTerminalStore(state => state.started)
  const start = useTerminalStore(state => state.start)
  const pruneProjects = useTerminalStore(state => state.pruneProjects)
  const projects = useWorkspaceStore(state => state.projects)
  const loaded = useWorkspaceStore(state => state.loaded)

  const route = tabForPath(pathname ?? "")
  const activeId = route?.kind === "terminal" ? route.id : null
  const activeExists = activeId !== null && terminals.some(t => t.id === activeId)

  // A shell starts the first time its terminal is opened in this page load.
  useEffect(() => {
    if (activeId && activeExists) start(activeId)
  }, [activeId, activeExists, start])

  useEffect(() => {
    if (loaded) pruneProjects(new Set(projects.map(p => p.project_id)))
  }, [loaded, projects, pruneProjects])

  // Capture phase, so the shortcut works even while xterm has focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.code !== "Backquote") return
      const projectId = useWorkspaceStore.getState().currentProjectId
      if (!projectId) return
      e.preventDefault()
      e.stopPropagation()
      const store = useTerminalStore.getState()
      const terminal = store.terminals.filter(t => t.projectId === projectId).at(-1) ?? store.createTerminal(projectId)
      router.push(`/terminals/${projectId}/${terminal.id}`)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [router])

  return (
    <>
      {terminals.filter(t => started[t.id]).map(terminal => {
        const shown = terminal.id === activeId
        return (
          <div
            key={terminal.id}
            className={cn("absolute inset-0 bg-background pt-1.5 pb-1 pl-3", !shown && "invisible")}
          >
            <TerminalView terminalId={terminal.id} projectId={terminal.projectId} visible={shown} />
          </div>
        )
      })}
    </>
  )
}
