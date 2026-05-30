"use client"

// Open-tabs store — the VSCode-style editor tabs across the top of the main
// pane. A tab is just a pointer to a session or harness route; its title and
// icon are resolved live from the workspace store at render time so renames and
// title updates show up without touching this store. Order is the open order;
// the active tab is derived from the current pathname, not stored here.

import { create } from "zustand"

export type TabKind = "session" | "harness"

export interface Tab {
  kind: TabKind
  id: string
}

const STORAGE_KEY = "cattery:open-tabs"

export function tabKey(kind: TabKind, id: string): string {
  return `${kind}:${id}`
}

export function tabHref(tab: Tab): string {
  return tab.kind === "session" ? `/sessions/${tab.id}` : `/harnesses/${tab.id}`
}

// Parse a workspace pathname into the tab it represents, or null for routes
// that aren't tabbed (home, admin, …).
export function tabForPath(pathname: string): Tab | null {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 2 && parts[0] === "sessions") return { kind: "session", id: parts[1] }
  if (parts.length === 2 && parts[0] === "harnesses") return { kind: "harness", id: parts[1] }
  return null
}

function readTabs(): Tab[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is Tab =>
        !!t && (t.kind === "session" || t.kind === "harness") && typeof t.id === "string",
    )
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
  closeTab: (kind: TabKind, id: string) => void
  closeOthers: (kind: TabKind, id: string) => void
  closeAll: () => void
  // Drop tabs whose entity no longer exists. Callers pass the set of valid
  // tabKey()s; only mutates when something actually changed.
  pruneTabs: (validKeys: Set<string>) => void
}

export const useTabsStore = create<TabsStore>(set => ({
  tabs: readTabs(),

  openTab: tab =>
    set(state => {
      if (state.tabs.some(t => t.kind === tab.kind && t.id === tab.id)) return state
      const tabs = [...state.tabs, tab]
      writeTabs(tabs)
      return { tabs }
    }),

  closeTab: (kind, id) =>
    set(state => {
      const tabs = state.tabs.filter(t => !(t.kind === kind && t.id === id))
      if (tabs.length === state.tabs.length) return state
      writeTabs(tabs)
      return { tabs }
    }),

  closeOthers: (kind, id) =>
    set(state => {
      const tabs = state.tabs.filter(t => t.kind === kind && t.id === id)
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
      const tabs = state.tabs.filter(t => validKeys.has(tabKey(t.kind, t.id)))
      if (tabs.length === state.tabs.length) return state
      writeTabs(tabs)
      return { tabs }
    }),
}))
