"use client"

import { create } from "zustand"
import {
  createSession as apiCreateSession,
  deleteHarness as apiDeleteHarness,
  deleteSession as apiDeleteSession,
  getHarness,
  getSession,
  listHarnesses,
  listSessions,
  updateHarness,
  updateSessionTitle,
  type Harness,
  type Session,
} from "@/lib/api"

export interface HarnessWithSessions extends Harness {
  sessions: Session[]
  expanded: boolean
}

const EXPANDED_HARNESSES_KEY = "cattery:expanded-harnesses"

function readExpandedHarnessIds(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(EXPANDED_HARNESSES_KEY)
    const ids = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

function writeExpandedHarnessIds(ids: Set<string>) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(EXPANDED_HARNESSES_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore browser storage failures; the in-memory state is still correct.
  }
}

function setStoredHarnessExpanded(harnessId: string, expanded: boolean) {
  const ids = readExpandedHarnessIds()
  if (expanded) ids.add(harnessId)
  else ids.delete(harnessId)
  writeExpandedHarnessIds(ids)
}

interface WorkspaceStore {
  harnesses: HarnessWithSessions[]
  busySessions: Set<string>
  loaded: boolean
  loadHarnesses: () => Promise<void>
  toggleExpand: (harnessId: string) => void
  setHarnessesExpanded: (harnessIds: string[], expanded: boolean) => void
  updateSessionTitle: (sessionId: string, title: string) => void
  renameHarness: (harnessId: string, name: string) => Promise<Harness>
  renameSession: (sessionId: string, title: string) => Promise<Session>
  addHarness: (harness: Harness) => void
  createSession: (harness: HarnessWithSessions, theme: "light" | "dark") => Promise<Session>
  deleteHarness: (harnessId: string) => Promise<HarnessWithSessions | undefined>
  deleteSession: (sessionId: string, harnessId: string) => Promise<void>
  refreshSession: (sessionId: string) => Promise<Session>
  pollHarnesses: () => Promise<void>
  setSessionBusy: (sessionId: string, busy: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  harnesses: [],
  busySessions: new Set(),
  loaded: false,

  loadHarnesses: async () => {
    const list = await listHarnesses()
    const storedExpanded = readExpandedHarnessIds()
    const withSessions = await Promise.all(
      list.map(async h => ({ harness: h, sessions: await listSessions(h.harness_id).catch(() => []) }))
    )
    writeExpandedHarnessIds(new Set([...storedExpanded].filter(id => list.some(h => h.harness_id === id))))
    set(state => ({
      loaded: true,
      harnesses: withSessions.map(({ harness, sessions }) => {
        const existing = state.harnesses.find(p => p.harness_id === harness.harness_id)
        return { ...harness, sessions, expanded: existing?.expanded ?? storedExpanded.has(harness.harness_id) }
      }),
    }))
  },

  toggleExpand: (harnessId: string) => {
    const harness = get().harnesses.find(h => h.harness_id === harnessId)
    if (harness && !harness.expanded && harness.sessions.length === 0) {
      void listSessions(harnessId).then(sessions => {
        set(state => ({
          harnesses: state.harnesses.map(h =>
            h.harness_id === harnessId ? { ...h, sessions } : h
          ),
        }))
      })
    }
    if (harness) setStoredHarnessExpanded(harnessId, !harness.expanded)
    set(state => ({
      harnesses: state.harnesses.map(h =>
        h.harness_id === harnessId ? { ...h, expanded: !h.expanded } : h
      ),
    }))
  },

  setHarnessesExpanded: (harnessIds: string[], expanded: boolean) => {
    const ids = new Set(harnessIds)
    const storedExpanded = readExpandedHarnessIds()
    for (const id of ids) {
      if (expanded) storedExpanded.add(id)
      else storedExpanded.delete(id)
    }
    writeExpandedHarnessIds(storedExpanded)
    set(state => ({
      harnesses: state.harnesses.map(h =>
        ids.has(h.harness_id) ? { ...h, expanded } : h
      ),
    }))
  },

  renameHarness: async (harnessId: string, name: string) => {
    const updated = await updateHarness(harnessId, { harness_name: name })
    set(state => ({
      harnesses: state.harnesses.map(h =>
        h.harness_id === harnessId ? { ...h, harness_name: updated.harness_name } : h
      ),
    }))
    return updated
  },

  updateSessionTitle: (sessionId: string, title: string) => {
    set(state => ({
      harnesses: state.harnesses.map(h => ({
        ...h,
        sessions: h.sessions.map(s => s.session_id === sessionId ? { ...s, title } : s),
      })),
    }))
  },

  renameSession: async (sessionId: string, title: string) => {
    const updated = await updateSessionTitle(sessionId, { title })
    get().updateSessionTitle(sessionId, updated.title ?? title)
    return updated
  },

  addHarness: (harness: Harness) => {
    set(state => ({
      harnesses: [{ ...harness, sessions: [], expanded: false }, ...state.harnesses],
    }))
  },

  createSession: async (harness: HarnessWithSessions, theme: "light" | "dark") => {
    const session = await apiCreateSession(harness.harness_id, theme)
    setStoredHarnessExpanded(harness.harness_id, true)
    set(state => ({
      harnesses: state.harnesses.map(h =>
        h.harness_id === harness.harness_id
          ? { ...h, sessions: [session, ...h.sessions], expanded: true }
          : h
      ),
    }))
    pollSessionStatus(session.session_id, harness.harness_id)
    return session
  },

  deleteHarness: async (harnessId: string) => {
    const removed = get().harnesses.find(h => h.harness_id === harnessId)
    await apiDeleteHarness(harnessId)
    setStoredHarnessExpanded(harnessId, false)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      for (const session of removed?.sessions ?? []) {
        nextBusy.delete(session.session_id)
      }
      return {
        busySessions: nextBusy,
        harnesses: state.harnesses.filter(h => h.harness_id !== harnessId),
      }
    })
    return removed
  },

  deleteSession: async (sessionId: string, harnessId: string) => {
    await apiDeleteSession(sessionId)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      nextBusy.delete(sessionId)
      return {
        busySessions: nextBusy,
        harnesses: state.harnesses.map(h =>
          h.harness_id === harnessId
            ? { ...h, sessions: h.sessions.filter(s => s.session_id !== sessionId) }
            : h
        ),
      }
    })
  },

  refreshSession: async (sessionId: string) => {
    const session = await getSession(sessionId)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      if (session.status === "dead") {
        nextBusy.delete(sessionId)
      }
      return {
        busySessions: nextBusy,
        harnesses: state.harnesses.map(h =>
          h.harness_id === session.harness_id
            ? {
                ...h,
                sessions: session.status === "dead"
                  ? h.sessions.filter(s => s.session_id !== sessionId)
                  : h.sessions.some(s => s.session_id === sessionId)
                    ? h.sessions.map(s => s.session_id === sessionId ? session : s)
                    : [session, ...h.sessions],
              }
            : h
        ),
      }
    })
    return session
  },

  pollHarnesses: async () => {
    const ids = get().harnesses
      .filter(h => h.sandbox_status !== "ready" && h.sandbox_status !== "failed")
      .map(h => h.harness_id)
    if (ids.length === 0) return
    const updates = await Promise.all(ids.map(id => getHarness(id).catch(() => null)))
    set(state => ({
      harnesses: state.harnesses.map(h => {
        const u = updates.find(x => x?.harness_id === h.harness_id)
        return u && u.sandbox_status !== h.sandbox_status
          ? { ...h, sandbox_status: u.sandbox_status }
          : h
      }),
    }))
  },

  setSessionBusy: (sessionId: string, busy: boolean) => {
    set(state => {
      const next = new Set(state.busySessions)
      if (busy) next.add(sessionId)
      else next.delete(sessionId)
      return { busySessions: next }
    })
  },
}))

export function selectSessionWithHarness(sessionId: string) {
  const harnesses = useWorkspaceStore.getState().harnesses
  for (const harness of harnesses) {
    const session = harness.sessions.find(s => s.session_id === sessionId)
    if (session) return { session, harness }
  }
  return null
}

function pollSessionStatus(sessionId: string, harnessId: string) {
  const timer = setInterval(async () => {
    try {
      const updated = await getSession(sessionId)
      if (updated.status !== "creating") {
        clearInterval(timer)
      }
      useWorkspaceStore.setState(state => ({
        harnesses: state.harnesses.map(h =>
          h.harness_id === harnessId
            ? { ...h, sessions: h.sessions.map(s => s.session_id === sessionId ? updated : s) }
            : h
        ),
      }))
    } catch {
      clearInterval(timer)
    }
  }, 1500)
}
