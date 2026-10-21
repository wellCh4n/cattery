"use client"

// Terminal store — the project terminals listed in the sidebar and opened as
// main-pane tabs (/terminals/<projectId>/<id>). The list is persisted so tabs
// survive a reload; shells are not. A terminal's shell starts the first time it
// is opened in a page load (`started`) and lives until the terminal is removed,
// independent of its tab — like a session, closing the tab keeps it running.

import { create } from "zustand"

export interface Terminal {
  id: string
  projectId: string
  // "New Terminal" until the user renames it.
  title: string
  createdAt: string
}

export type TerminalStatus = "connecting" | "open" | "closed"

const STORAGE_KEY = "cattery:terminals"

export const DEFAULT_TERMINAL_TITLE = "New Terminal"

interface Persisted {
  terminals: Terminal[]
}

function readPersisted(): Persisted {
  const empty = { terminals: [] }
  if (typeof window === "undefined") return empty
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
    if (!parsed || !Array.isArray(parsed.terminals)) return empty
    return {
      terminals: parsed.terminals.filter((t: Terminal) => t && typeof t.id === "string" && typeof t.projectId === "string"),
    }
  } catch {
    return empty
  }
}

function writePersisted(state: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ terminals: state.terminals }))
  } catch {
    // Storage may be unavailable; the in-memory list still works.
  }
}

interface TerminalState extends Persisted {
  // Terminal id → true once its shell has been started this page load.
  started: Record<string, true>
  // Live connection state of started shells.
  status: Record<string, TerminalStatus>
  createTerminal: (projectId: string) => Terminal
  renameTerminal: (id: string, title: string) => void
  removeTerminal: (id: string) => void
  // Drop terminals of projects that no longer exist.
  pruneProjects: (projectIds: Set<string>) => void
  start: (id: string) => void
  setStatus: (id: string, status: TerminalStatus) => void
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  ...readPersisted(),
  started: {},
  status: {},

  createTerminal: projectId => {
    const terminal = { id: crypto.randomUUID(), projectId, title: DEFAULT_TERMINAL_TITLE, createdAt: new Date().toISOString() }
    const next = { terminals: [...get().terminals, terminal] }
    writePersisted(next)
    set(next)
    return terminal
  },

  renameTerminal: (id, title) => {
    const next = { terminals: get().terminals.map(t => (t.id === id ? { ...t, title } : t)) }
    writePersisted(next)
    set(next)
  },

  removeTerminal: id => {
    const { terminals, started, status } = get()
    if (!terminals.some(t => t.id === id)) return
    const next = { terminals: terminals.filter(t => t.id !== id) }
    writePersisted(next)
    const restStarted = { ...started }
    const restStatus = { ...status }
    delete restStarted[id]
    delete restStatus[id]
    set({ ...next, started: restStarted, status: restStatus })
  },

  pruneProjects: projectIds => {
    const { terminals } = get()
    const kept = terminals.filter(t => projectIds.has(t.projectId))
    if (kept.length === terminals.length) return
    const next = { terminals: kept }
    writePersisted(next)
    set(next)
  },

  start: id => {
    if (get().started[id]) return
    set(state => ({ started: { ...state.started, [id]: true } }))
  },

  setStatus: (id, status) => {
    if (!get().started[id] || get().status[id] === status) return
    set(state => ({ status: { ...state.status, [id]: status } }))
  },
}))
