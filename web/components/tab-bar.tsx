"use client"

// TabBar — VSCode-style editor tabs across the top of the main pane. Every
// session/harness route the user visits becomes a tab (opened lazily on
// navigation); the active tab tracks the current pathname. Tabs are closable
// (× button, middle-click, or right-click menu), and closing the active tab
// falls back to a neighbouring tab — or home when none are left. Titles, icons
// and status all resolve live from the workspace store, so renames and session
// title updates reflect immediately. Tabs whose entity has been deleted are
// pruned once the workspace has loaded.

import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Bot, MessageSquare, Terminal, X } from "lucide-react"
import { HarnessIcon } from "@/components/harness-icon"
import { cn } from "@/lib/utils"
import { type ProjectWithHarnesses, useWorkspaceStore } from "@/lib/workspace-store"
import { type Tab, tabForPath, tabHref, tabKey, useTabsStore } from "@/lib/tabs-store"

interface ResolvedTab {
  title: string
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
    if (harness) return harness
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
      return { title: "Session", exists: false, icon: <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" /> }
    }
    const Icon = found.harness.transport_kind === "terminal" ? Terminal : MessageSquare
    return {
      title: found.session.title ?? "New Session",
      exists: true,
      icon: <Icon className={cn("size-3.5 shrink-0", sessionIconColor(found.session.status))} />,
    }
  }
  const harness = findHarness(projects, tab.id)
  if (!harness) {
    return { title: "Harness", exists: false, icon: <Bot className="size-3.5 shrink-0 text-muted-foreground" /> }
  }
  return {
    title: harness.harness_name ?? "Untitled",
    exists: true,
    icon: <HarnessIcon id={harness.type} className="size-3.5 shrink-0 text-muted-foreground" />,
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

  const active = tabForPath(pathname ?? "")
  const activeKey = active ? tabKey(active.kind, active.id) : null

  // Open (or just focus) a tab whenever we land on a session/harness route.
  useEffect(() => {
    if (active) openTab(active)
    // active is reconstructed from activeKey each render; depend on the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, openTab])

  const validKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const project of projects) {
      for (const harness of project.harnesses) {
        keys.add(tabKey("harness", harness.harness_id))
        for (const session of harness.sessions) keys.add(tabKey("session", session.session_id))
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
    const idx = tabs.findIndex(t => t.kind === tab.kind && t.id === tab.id)
    const wasActive = activeKey === tabKey(tab.kind, tab.id)
    closeTab(tab.kind, tab.id)
    if (!wasActive) return
    // Activate a neighbour — prefer the right one, then the left, else home.
    const next = tabs[idx + 1] ?? tabs[idx - 1] ?? null
    router.push(next ? tabHref(next) : "/")
  }

  if (tabs.length === 0) return null

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-muted/20">
      {tabs.map(tab => {
        const key = tabKey(tab.kind, tab.id)
        const r = resolveTab(tab, projects)
        const isActive = activeKey === key
        const busy = tab.kind === "session" && busySessions.has(tab.id)
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            title={r.title}
            onClick={() => go(tab)}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); handleClose(tab) } }}
            onContextMenu={e => { e.preventDefault(); setMenu({ tab, x: e.clientX, y: e.clientY }) }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(tab) } }}
            className={cn(
              "group/tab relative flex min-w-28 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 text-xs select-none",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            {isActive && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
            {r.icon}
            <span className={cn("min-w-0 flex-1 truncate", !r.exists && "italic line-through opacity-60")}>
              {r.title}
            </span>
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
                  "absolute inset-0 flex items-center justify-center rounded hover:bg-foreground/10 hover:text-foreground",
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
          onCloseOthers={() => { closeOthers(menu.tab.kind, menu.tab.id); go(menu.tab); setMenu(null) }}
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
