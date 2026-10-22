"use client"

// TerminalHost — draws started shells over the main pane. It lives in the
// workspace layout, not the /terminals route, so a shell keeps its connection
// and scrollback while other tabs are shown; only the routed one is visible.
// Ctrl+` jumps to the current project's newest terminal, creating one if needed.

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { TerminalView } from "@/components/terminal-view"
import { tabForPath } from "@/lib/tabs-store"
import { useProjectTerminalsStore, useTerminalStore } from "@/lib/terminal-store"
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
  const currentProjectId = useWorkspaceStore(state => state.currentProjectId)

  const route = tabForPath(pathname ?? "")
  const activeId = route?.kind === "terminal" ? route.id : null
  const activeExists = activeId !== null && terminals.some(t => t.terminal_id === activeId && t.project_id === route?.projectId)

  // A shell starts the first time its terminal is opened in this page load.
  useEffect(() => {
    if (activeId && activeExists) start(activeId)
  }, [activeId, activeExists, start])

  useEffect(() => {
    if (!loaded) return
    pruneProjects(new Set(projects.map(p => p.project_id)))
    for (const project of projects) void useProjectTerminalsStore.getState().load(project.project_id)
  }, [loaded, projects, pruneProjects])

  const refreshProjects = [...new Set([
    currentProjectId,
    route?.kind === "terminal" ? route.projectId : null,
    ...terminals.filter(t => started[t.terminal_id]).map(t => t.project_id),
  ].filter((id): id is string => !!id))].sort().join(",")
  useEffect(() => {
    if (!loaded || !refreshProjects) return
    const refresh = () => {
      for (const id of refreshProjects.split(",")) void useProjectTerminalsStore.getState().invalidate(id)
    }
    refresh()
    const timer = setInterval(refresh, 15000)
    window.addEventListener("focus", refresh)
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh) }
  }, [loaded, refreshProjects])

  // Capture phase, so the shortcut works even while xterm has focus.
  useEffect(() => {
    let opening = false
    async function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.code !== "Backquote") return
      const projectId = useWorkspaceStore.getState().currentProjectId
      if (!projectId) return
      e.preventDefault()
      e.stopPropagation()
      if (opening) return
      opening = true
      try {
        const terminals = await useProjectTerminalsStore.getState().invalidate(projectId)
        if (!terminals) throw new Error(useProjectTerminalsStore.getState().entries[projectId]?.error ?? "Failed to load terminals")
        const terminal = terminals[0] ?? await useTerminalStore.getState().createTerminal(projectId)
        router.push(`/terminals/${projectId}/${terminal.terminal_id}`)
      } catch (err) { window.alert(err instanceof Error ? err.message : "Failed to open terminal") }
      finally { opening = false }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [router])

  return (
    <>
      {terminals.filter(t => started[t.terminal_id]).map(terminal => {
        const shown = terminal.terminal_id === activeId
        return (
          <div
            key={terminal.terminal_id}
            className={cn("absolute inset-0 bg-background pt-1.5 pb-1 pl-3", !shown && "invisible")}
          >
            <TerminalView terminalId={terminal.terminal_id} projectId={terminal.project_id} visible={shown} />
          </div>
        )
      })}
    </>
  )
}
