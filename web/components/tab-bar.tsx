"use client"

// TabBar — VSCode-style editor tabs across the top of the main pane. Every
// session/harness/skill/file route the user visits becomes a tab (opened
// lazily on navigation); the active tab tracks the current pathname. Tabs are
// closable (× button, middle-click, or right-click menu), and closing the
// active tab falls back to a neighbouring tab — or home when none are left.
// Titles, icons and status all resolve live from the workspace store, so
// renames and session title updates reflect immediately. Session/harness tabs
// whose entity has been deleted are pruned once the workspace has loaded.

import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Bot, File as FileIcon, MessageSquare, Puzzle, Terminal, X } from "lucide-react"
import { HarnessIcon } from "@/components/harness-icon"
import { cn } from "@/lib/utils"
import { type ProjectWithHarnesses, useWorkspaceStore } from "@/lib/workspace-store"
import { type Tab, sameTab, tabForPath, tabHref, tabKey, useTabsStore } from "@/lib/tabs-store"

interface ResolvedTab {
  title: string
  // Parent context shown under the title: harness name for a session tab,
  // project name for a harness tab.
  subtitle: string
  exists: boolean
  icon: React.ReactNode
}

function findSession(projects: ProjectWithHarnesses[], id: string) {
  for (const project of projects) {
    for (const harness of project.harnesses) {
      const session = harness.sessions.find(s => s.session_id === id)
      if (session) return { session, harness }
    }
  }
  return null
}

function findHarness(projects: ProjectWithHarnesses[], id: string) {
  for (const project of projects) {
    const harness = project.harnesses.find(h => h.harness_id === id)
    if (harness) return { harness, project }
  }
  return null
}

// Mirror the sidebar's status coloring: failed stands out, transitional states
// pulse amber, ready stays muted.
function sessionIconColor(status: string): string {
  if (status === "failed") return "text-destructive"
  if (status !== "ready") return "text-amber-500 animate-pulse"
  return "text-muted-foreground"
}

function resolveTab(tab: Tab, projects: ProjectWithHarnesses[]): ResolvedTab {
  if (tab.kind === "session") {
    const found = findSession(projects, tab.id)
    if (!found) {
      return { title: "Session", subtitle: "", exists: false, icon: <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" /> }
    }
    const Icon = found.harness.transport_kind === "terminal" ? Terminal : MessageSquare
    return {
      title: found.session.title ?? "New Session",
      subtitle: found.harness.harness_name ?? "Untitled",
      exists: true,
      icon: <Icon className={cn("size-3.5 shrink-0", sessionIconColor(found.session.status))} />,
    }
  }
  if (tab.kind === "harness") {
    const found = findHarness(projects, tab.id)
    if (!found) {
      return { title: "Harness", subtitle: "", exists: false, icon: <Bot className="size-3.5 shrink-0 text-muted-foreground" /> }
    }
    return {
      title: found.harness.harness_name ?? "Untitled",
      subtitle: found.project.project_name ?? "Untitled Project",
      exists: true,
      icon: <HarnessIcon id={found.harness.type} className="size-3.5 shrink-0 text-muted-foreground" />,
    }
  }
  if (tab.kind === "skill") {
    return {
      title: tab.id,
      subtitle: "Skills",
      exists: true,
      icon: <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />,
    }
  }
  // file: name from the path basename, project name as context.
  const name = tab.id.split("/").filter(Boolean).pop() ?? tab.id
  const project = projects.find(p => p.project_id === tab.projectId)
  return {
    title: name,
    subtitle: project?.project_name ?? "Files",
    exists: true,
    icon: <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />,
  }
}

export function TabBar() {
  const router = useRouter()
  const pathname = usePathname()
  const tabs = useTabsStore(s => s.tabs)
  const openTab = useTabsStore(s => s.openTab)
  const closeTab = useTabsStore(s => s.closeTab)
  const closeOthers = useTabsStore(s => s.closeOthers)
  const closeAll = useTabsStore(s => s.closeAll)
  const pruneTabs = useTabsStore(s => s.pruneTabs)
  const projects = useWorkspaceStore(s => s.projects)
  const loaded = useWorkspaceStore(s => s.loaded)
  const busySessions = useWorkspaceStore(s => s.busySessions)
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null)
  const activeTabRef = useRef<HTMLDivElement | null>(null)

  const active = tabForPath(pathname ?? "")
  const activeKey = active ? tabKey(active) : null

  // Keep the active tab in view — scroll the strip to it when it changes (e.g.
  // the tab is off-screen, or a freshly-opened one was appended at the end).
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
  }, [activeKey])

  // Open (or just focus) a tab whenever we land on a tabbed route.
  useEffect(() => {
    if (active) openTab(active)
    // active is reconstructed from activeKey each render; depend on the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, openTab])

  const validKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const project of projects) {
      for (const harness of project.harnesses) {
        keys.add(tabKey({ kind: "harness", id: harness.harness_id }))
        for (const session of harness.sessions) keys.add(tabKey({ kind: "session", id: session.session_id }))
      }
    }
    return keys
  }, [projects])

  // Once the workspace is loaded, drop tabs whose entity is gone (deleted
  // harness/session). Never prune the route we're currently viewing — a
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
    <div className="no-scrollbar flex h-12 shrink-0 items-stretch overflow-x-auto border-b bg-muted/20">
      {tabs.map(tab => {
        const key = tabKey(tab)
        const r = resolveTab(tab, projects)
        const isActive = activeKey === key
        const busy = tab.kind === "session" && busySessions.has(tab.id)
        return (
          <div
            key={key}
            ref={isActive ? activeTabRef : undefined}
            role="button"
            tabIndex={0}
            title={r.title}
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
            {isActive && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
            {r.icon}
            <div className="min-w-0 flex-1 leading-tight">
              <div className={cn("truncate", !r.exists && "italic line-through opacity-60")}>
                {r.title}
              </div>
              <div className="truncate text-[10px] text-muted-foreground/70">
                {r.subtitle}
              </div>
            </div>
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              {busy && (
                <span className="size-1.5 rounded-full bg-amber-500 animate-pulse group-hover/tab:hidden" />
              )}
              <button
                type="button"
                aria-label="Close tab"
                title="Close"
                onClick={e => { e.stopPropagation(); handleClose(tab) }}
                className={cn(
                  "absolute inset-0 flex cursor-pointer items-center justify-center rounded hover:bg-foreground/10 hover:text-foreground",
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
        )
      })}

      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          multiple={tabs.length > 1}
          onClose={() => setMenu(null)}
          onCloseTab={() => { handleClose(menu.tab); setMenu(null) }}
          onCloseOthers={() => { closeOthers(menu.tab); go(menu.tab); setMenu(null) }}
          onCloseAll={() => { closeAll(); router.push("/"); setMenu(null) }}
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
      className="fixed z-50 min-w-36 overflow-hidden rounded-md border bg-popover py-1 text-xs text-popover-foreground shadow-md"
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
