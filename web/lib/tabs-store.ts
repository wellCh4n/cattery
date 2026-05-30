"use client"

// Open-tabs store — the VSCode-style editor tabs across the top of the main
// pane. A tab is a pointer to a routed view: a session, a harness, a skill, or
// a file (file tabs also carry the owning projectId). Titles and icons are
// resolved live at render time (see tab-bar) so renames show up without
// touching this store. Order is the open order; the active tab is derived from
// the current pathname, not stored here.

import { create } from "zustand"

export type TabKind = "session" | "harness" | "skill" | "file" | "admin"

export interface Tab {
  kind: TabKind
  // session_id / harness_id / skill slug / file path (absolute, e.g. /src/a.go) / admin sub-section ("users")
  id: string
  // Only set for file tabs — the project the file lives in.
  projectId?: string
}

const STORAGE_KEY = "cattery:open-tabs"

export function tabKey(tab: Tab): string {
  return tab.kind === "file" ? `file:${tab.projectId}:${tab.id}` : `${tab.kind}:${tab.id}`
}

export function sameTab(a: Tab, b: Tab): boolean {
  return a.kind === b.kind && a.id === b.id && a.projectId === b.projectId
}

export function tabHref(tab: Tab): string {
  switch (tab.kind) {
    case "session": return `/sessions/${tab.id}`
    case "harness": return `/harnesses/${tab.id}`
    case "skill":   return `/skills/${encodeURIComponent(tab.id)}`
    case "admin":   return `/admin/${tab.id}`
    case "file": {
      const segs = tab.id.split("/").filter(Boolean).map(encodeURIComponent)
      return `/files/${tab.projectId}/${segs.join("/")}`
    }
  }
}

// Parse a workspace pathname into the tab it represents, or null for routes
// that aren't tabbed (home, …).
export function tabForPath(pathname: string): Tab | null {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 2 && parts[0] === "sessions") return { kind: "session", id: parts[1] }
  if (parts.length === 2 && parts[0] === "harnesses") return { kind: "harness", id: parts[1] }
  if (parts.length === 2 && parts[0] === "skills") return { kind: "skill", id: decodeURIComponent(parts[1]) }
  if (parts.length === 2 && parts[0] === "admin") return { kind: "admin", id: parts[1] }
  if (parts.length >= 3 && parts[0] === "files") {
    const projectId = parts[1]
    const path = "/" + parts.slice(2).map(decodeURIComponent).join("/")
    return { kind: "file", id: path, projectId }
  }
  return null
}

function readTabs(): Tab[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is Tab => {
      if (!t || typeof t.id !== "string") return false
      if (t.kind === "file") return typeof t.projectId === "string"
      return t.kind === "session" || t.kind === "harness" || t.kind === "skill" || t.kind === "admin"
    })
  } catch {
    return []
  }
}

function writeTabs(tabs: Tab[]) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
  } catch {
    // Ignore browser storage failures; the in-memory state is still correct.
  }
}

interface TabsStore {
  tabs: Tab[]
  openTab: (tab: Tab) => void
  closeTab: (tab: Tab) => void
  closeOthers: (tab: Tab) => void
  closeAll: () => void
  // Drop session/harness tabs whose entity no longer exists. Callers pass the
  // set of valid tabKey()s; file/skill tabs are never pruned (we can't cheaply
  // validate them). Only mutates when something actually changed.
  pruneTabs: (validKeys: Set<string>) => void
}

export const useTabsStore = create<TabsStore>(set => ({
  tabs: readTabs(),

  openTab: tab =>
    set(state => {
      if (state.tabs.some(t => sameTab(t, tab))) return state
      const tabs = [...state.tabs, tab]
      writeTabs(tabs)
      return { tabs }
    }),

  closeTab: tab =>
    set(state => {
      const tabs = state.tabs.filter(t => !sameTab(t, tab))
      if (tabs.length === state.tabs.length) return state
      writeTabs(tabs)
      return { tabs }
    }),

  closeOthers: tab =>
    set(state => {
      const tabs = state.tabs.filter(t => sameTab(t, tab))
      if (tabs.length === state.tabs.length) return state
      writeTabs(tabs)
      return { tabs }
    }),

  closeAll: () =>
    set(state => {
      if (state.tabs.length === 0) return state
      writeTabs([])
      return { tabs: [] }
    }),

  pruneTabs: validKeys =>
    set(state => {
      const tabs = state.tabs.filter(
        t => (t.kind !== "session" && t.kind !== "harness") || validKeys.has(tabKey(t)),
      )
      if (tabs.length === state.tabs.length) return state
      writeTabs(tabs)
      return { tabs }
    }),
}))
