"use client"

// TabBar — VSCode-style editor tabs across the top of the main pane. Every
// session/skill/file/terminal route the user visits becomes a tab (opened
// lazily on navigation); the active tab tracks the current pathname. Tabs are
// closable (× button, middle-click, or right-click menu), and closing the
// active tab falls back to a neighbouring tab — or home when none are left.
// Titles, icons and status all resolve live from the workspace store, so
// renames and session title updates reflect immediately. Session and terminal
// tabs whose target has been deleted are pruned once the workspace has loaded.

import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { File as FileIcon, MessageSquare, Puzzle, Shield, SquareTerminal, X } from "lucide-react"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
import { type Terminal, useProjectTerminalsStore, useTerminalStore } from "@/lib/terminal-store"
import { findSession, type ProjectWithSessions, useWorkspaceStore } from "@/lib/workspace-store"
import { type Tab, rememberProjectTab, projectTabToRestore, sameTab, tabForPath, tabHref, tabKey, useTabsStore } from "@/lib/tabs-store"

interface ResolvedTab {
  title: string
  exists: boolean
  icon: React.ReactNode
}

// Mirror the sidebar's status coloring: failed stands out, transitional states
// pulse amber, ready stays muted.
function sessionIconColor(status: string): string {
  if (status === "failed") return "text-destructive"
  if (status !== "ready") return "text-amber-500 animate-pulse"
  return "text-muted-foreground"
}

function resolveTab(tab: Tab, projects: ProjectWithSessions[], terminals: Terminal[]): ResolvedTab {
  if (tab.kind === "session") {
    const found = findSession(projects, tab.id)
    if (!found) {
      return { title: "Session", exists: false, icon: <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" /> }
    }
    return {
      title: found.session.title ?? "New Session",
      exists: true,
      icon: <MessageSquare className={cn("size-3.5 shrink-0", sessionIconColor(found.session.status))} />,
    }
  }
  if (tab.kind === "terminal") {
    const terminal = terminals.find(t => t.terminal_id === tab.id)
    return {
      title: terminal?.title ?? "Terminal",
      exists: terminal !== undefined,
      icon: <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />,
    }
  }
  if (tab.kind === "skill") {
    return {
      title: tab.id,
      exists: true,
      icon: <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />,
    }
  }
  if (tab.kind === "admin") {
    // tab.id is the sub-section ("users"); for now just title-case it.
    const title = tab.id.charAt(0).toUpperCase() + tab.id.slice(1)
    return {
      title,
      exists: true,
      icon: <Shield className="size-3.5 shrink-0 text-muted-foreground" />,
    }
  }
  // File tabs use the path basename as their title.
  const name = tab.id.split("/").filter(Boolean).pop() ?? tab.id
  return {
    title: name,
    exists: true,
    icon: <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />,
  }
}

export function TabBar() {
  const router = useRouter()
  const pathname = usePathname()
  const allTabs = useTabsStore(s => s.tabs)
  const openTab = useTabsStore(s => s.openTab)
  const closeTab = useTabsStore(s => s.closeTab)
  const closeOthers = useTabsStore(s => s.closeOthers)
  const closeAll = useTabsStore(s => s.closeAll)
  const pruneTabs = useTabsStore(s => s.pruneTabs)
  const projects = useWorkspaceStore(s => s.projects)
  const terminals = useTerminalStore(s => s.terminals)
  const terminalResources = useProjectTerminalsStore(s => s.entries)
  const loaded = useWorkspaceStore(s => s.loaded)
  const currentProjectId = useWorkspaceStore(s => s.currentProjectId)
  const setCurrentProject = useWorkspaceStore(s => s.setCurrentProject)
  const previousContext = useRef<{ projectId: string | null; pathname: string } | null>(null)
  const pendingPath = useRef<string | null>(null)
  const openedRoute = useRef<string | null>(null)
  const tabs = useMemo(() => allTabs.filter(tab => {
    if (tab.kind === "session") return findSession(projects, tab.id)?.project.project_id === currentProjectId
    return (tab.projectId ?? null) === currentProjectId
  }), [allTabs, projects, currentProjectId])
  const busySessions = useWorkspaceStore(s => s.busySessions)
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null)
  const activeTabRef = useRef<HTMLDivElement | null>(null)

  const active = tabForPath(pathname ?? "")
  const activeKey = active ? tabKey(active) : null

  // Keep the active tab in view — scroll the strip to it when it changes (e.g.
  // the tab is off-screen, or a freshly-opened one was appended at the end).
  // Depend on `tabs` too: when a new tab is opened from elsewhere (file browser,
  // sidebar) it lands in the array on the render *after* activeKey changes, so
  // we need a second pass once the DOM node is mounted.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
  }, [activeKey, tabs])

  // Project selection restores its own route. Route navigation (including
  // browser history and deep links) instead selects the route's owning project.
  useEffect(() => {
    if (!loaded) return
    const previous = previousContext.current
    const projectChanged = previous && previous.projectId !== currentProjectId
    const pathChanged = previous && previous.pathname !== pathname
    previousContext.current = { projectId: currentProjectId, pathname }
    if (projectChanged && !pathChanged) {
      openedRoute.current = null
      const target = currentProjectId ? projectTabToRestore(currentProjectId, tabs) : null
      const href = target ? tabHref(target) : "/"
      pendingPath.current = href === pathname ? null : href
      if (href !== pathname) router.push(href)
      return
    }
    if (pendingPath.current) {
      if (pathname !== pendingPath.current) return
      pendingPath.current = null
    }
    const routeTab = tabForPath(pathname)
    if (!routeTab) {
      openedRoute.current = null
      const firstTab = tabs[0]
      // Wait for shared terminals to load so a deleted saved tab is pruned
      // before choosing the first remaining tab.
      const available = firstTab && (firstTab.kind !== "terminal" ||
        terminalResources[firstTab.projectId ?? ""]?.data?.some(t => t.terminal_id === firstTab.id))
      if (available) {
        const href = tabHref(firstTab)
        pendingPath.current = href
        router.replace(href)
      }
      return
    }
    const owner = routeTab.kind === "session"
      ? findSession(projects, routeTab.id)?.project.project_id
      : routeTab.kind === "file" || routeTab.kind === "terminal" ? routeTab.projectId : currentProjectId
    if (!owner) return
    const routeKey = `${owner}:${pathname}`
    if (openedRoute.current === routeKey) return
    openedRoute.current = routeKey
    const tab = routeTab.kind === "session" ? routeTab : { ...routeTab, projectId: owner }
    if (owner !== currentProjectId) {
      previousContext.current = { projectId: owner, pathname }
      setCurrentProject(owner)
    }
    openTab(tab)
    rememberProjectTab(owner, tab)
  }, [loaded, currentProjectId, pathname, projects, tabs, terminalResources, openTab, setCurrentProject, router])

  const validKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const project of projects) {
      for (const session of project.sessions) keys.add(tabKey({ kind: "session", id: session.session_id }))
    }
    for (const terminal of terminals) keys.add(tabKey({ kind: "terminal", id: terminal.terminal_id, projectId: terminal.project_id }))
    // Keep saved tabs until their shared terminal list has actually loaded.
    for (const tab of allTabs) {
      if (tab.kind === "terminal" && tab.projectId && projects.some(p => p.project_id === tab.projectId) && !terminalResources[tab.projectId]?.data) keys.add(tabKey(tab))
    }
    return keys
  }, [projects, terminals, allTabs, terminalResources])

  // Once the workspace is loaded, drop tabs whose session or terminal is gone. Never prune the route we're currently viewing — a
  // freshly-created session can briefly lag the store mid-poll.
  useEffect(() => {
    if (!loaded) return
    const keys = activeKey ? new Set(validKeys).add(activeKey) : validKeys
    pruneTabs(keys)
  }, [loaded, validKeys, activeKey, pruneTabs])

  function go(tab: Tab) {
    router.push(tabHref(tab))
  }

  function handleClose(tab: Tab) {
    const idx = tabs.findIndex(t => sameTab(t, tab))
    const wasActive = activeKey === tabKey(tab)
    closeTab(tab)
    if (!wasActive) return
    // Activate a neighbour — prefer the right one, then the left, else home.
    const next = tabs[idx + 1] ?? tabs[idx - 1] ?? null
    router.push(next ? tabHref(next) : "/")
  }

  if (tabs.length === 0) return null

  return (
    <div className="no-scrollbar flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-muted/20">
      {tabs.map(tab => {
        const key = tabKey(tab)
        const r = resolveTab(tab, projects, terminals)
        const isActive = activeKey === key
        const busy = tab.kind === "session" && busySessions.has(tab.id)
        return (
          <Hint key={key} label={r.title} side="top">
          <div
            ref={isActive ? activeTabRef : undefined}
            role="button"
            tabIndex={0}
            onClick={() => go(tab)}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); handleClose(tab) } }}
            onContextMenu={e => { e.preventDefault(); setMenu({ tab, x: e.clientX, y: e.clientY }) }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(tab) } }}
            className={cn(
              "group/tab relative flex w-48 shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 text-xs select-none",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
            {r.icon}
            <div className={cn("min-w-0 flex-1 truncate", !r.exists && "italic line-through opacity-60")}>
              {r.title}
            </div>
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              {busy && (
                <span className="size-1.5 rounded-full bg-amber-500 animate-pulse group-hover/tab:hidden" />
              )}
              <button
                type="button"
                aria-label="Close tab"
                onClick={e => { e.stopPropagation(); handleClose(tab) }}
                className={cn(
                  "absolute inset-0 flex cursor-pointer items-center justify-center rounded-sm hover:bg-foreground/10 hover:text-foreground",
                  busy
                    ? "opacity-0 group-hover/tab:opacity-100"
                    : isActive
                      ? "opacity-60 hover:opacity-100"
                      : "opacity-0 group-hover/tab:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
          </Hint>
        )
      })}

      {menu && tabs.some(tab => sameTab(tab, menu.tab)) && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          multiple={tabs.length > 1}
          onClose={() => setMenu(null)}
          onCloseTab={() => { handleClose(menu.tab); setMenu(null) }}
          onCloseOthers={() => { closeOthers(menu.tab, tabs); go(menu.tab); setMenu(null) }}
          onCloseAll={() => { closeAll(tabs); router.push("/"); setMenu(null) }}
        />
      )}
    </div>
  )
}

function TabContextMenu({
  x,
  y,
  multiple,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
}: {
  x: number
  y: number
  multiple: boolean
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-36 overflow-hidden rounded-lg border bg-popover py-1 text-xs text-popover-foreground shadow-md"
      style={{ top: y, left: x }}
    >
      <MenuItem onClick={onCloseTab}>Close</MenuItem>
      <MenuItem onClick={onCloseOthers} disabled={!multiple}>Close others</MenuItem>
      <MenuItem onClick={onCloseAll}>Close all</MenuItem>
    </div>
  )
}

function MenuItem({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
