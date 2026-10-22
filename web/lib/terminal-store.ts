"use client"

import { create } from "zustand"
import {
  createTerminal as apiCreateTerminal, deleteTerminal, importTerminals, listTerminals,
  renameTerminal as apiRenameTerminal, type LegacyTerminal, type Terminal,
} from "@/lib/api"
import { createResourceStore } from "@/lib/resource-store"

export type { Terminal } from "@/lib/api"
export type TerminalStatus = "connecting" | "open" | "closed"

// Only read the old browser list to migrate it. All current metadata lives in
// PostgreSQL; preserve IDs so the existing tmux shells remain reachable.
const LEGACY_STORAGE_KEY = "cattery:terminals"
function legacyTerminals(): LegacyTerminal[] {
  if (typeof window === "undefined") return []
  try {
    const data = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null")
    return Array.isArray(data?.terminals) ? data.terminals.filter((t: LegacyTerminal) =>
      t && typeof t.id === "string" && typeof t.projectId === "string" && typeof t.title === "string" &&
      typeof t.createdAt === "string" && Number.isFinite(Date.parse(t.createdAt)),
    ) : []
  } catch { return [] }
}

export const useProjectTerminalsStore = createResourceStore<Terminal[]>(async projectId => {
  const legacy = legacyTerminals().filter(t => t.projectId === projectId)
  if (legacy.length) {
    await importTerminals(projectId, legacy)
    try {
      const migrated = new Set(legacy.map(t => t.id))
      const remaining = legacyTerminals().filter(t => !migrated.has(t.id))
      if (remaining.length) localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ terminals: remaining }))
      else localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch { /* Retrying the import is safe if storage is unavailable. */ }
  }
  return listTerminals(projectId)
})

function updateMetadata(projectId: string, update: (items: Terminal[]) => Terminal[]) {
  useProjectTerminalsStore.setState(state => ({ entries: { ...state.entries, [projectId]: {
    ...state.entries[projectId], loading: false, stale: true, error: null,
    data: update(state.entries[projectId]?.data ?? [])
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.terminal_id.localeCompare(b.terminal_id)),
  } } }))
  void useProjectTerminalsStore.getState().invalidate(projectId)
}

interface TerminalState {
  terminals: Terminal[]
  // Connection state belongs to this browser tab; metadata is shared.
  started: Record<string, true>
  status: Record<string, TerminalStatus>
  createTerminal: (projectId: string) => Promise<Terminal>
  renameTerminal: (id: string, title: string) => Promise<void>
  removeTerminal: (id: string) => Promise<void>
  pruneProjects: (projectIds: Set<string>) => void
  reset: () => void
  start: (id: string) => void
  setStatus: (id: string, status: TerminalStatus) => void
}

let epoch = 0
export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [], started: {}, status: {},
  createTerminal: async projectId => {
    const startedEpoch = epoch
    const terminal = await apiCreateTerminal(projectId)
    if (startedEpoch !== epoch) throw new Error("Account changed while creating terminal")
    updateMetadata(projectId, items => [terminal, ...items.filter(t => t.terminal_id !== terminal.terminal_id)])
    return terminal
  },
  renameTerminal: async (id, title) => {
    const terminal = get().terminals.find(t => t.terminal_id === id)
    if (!terminal) throw new Error("Terminal not found")
    const startedEpoch = epoch
    const updated = await apiRenameTerminal(terminal.project_id, id, title)
    if (startedEpoch !== epoch) return
    updateMetadata(terminal.project_id, items => items.map(t => t.terminal_id === id ? updated : t))
  },
  removeTerminal: async id => {
    const terminal = get().terminals.find(t => t.terminal_id === id)
    if (!terminal) return
    const startedEpoch = epoch
    await deleteTerminal(terminal.project_id, id)
    if (startedEpoch !== epoch) return
    updateMetadata(terminal.project_id, items => items.filter(t => t.terminal_id !== id))
  },
  pruneProjects: projectIds => {
    const resources = useProjectTerminalsStore.getState()
    for (const id of Object.keys(resources.entries)) if (!projectIds.has(id)) resources.drop(id)
  },
  reset: () => {
    epoch++
    useProjectTerminalsStore.getState().reset()
    set({ terminals: [], started: {}, status: {} })
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

// Successful refreshes also unmount sockets for terminals deleted by a member.
useProjectTerminalsStore.subscribe(({ entries }) => {
  const terminals = Object.values(entries).flatMap(entry => entry.data ?? [])
  const ids = new Set(terminals.map(t => t.terminal_id))
  useTerminalStore.setState(state => ({
    terminals,
    started: Object.fromEntries(Object.entries(state.started).filter(([id]) => ids.has(id))),
    status: Object.fromEntries(Object.entries(state.status).filter(([id]) => ids.has(id))),
  }))
})
