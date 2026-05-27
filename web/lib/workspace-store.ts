"use client"

import { create } from "zustand"
import {
  createHarness as apiCreateHarness,
  createProject as apiCreateProject,
  createSession as apiCreateSession,
  deleteHarness as apiDeleteHarness,
  deleteProject as apiDeleteProject,
  deleteSession as apiDeleteSession,
  getHarness,
  getSession,
  listHarnesses,
  listProjects,
  listSessions,
  updateHarness,
  updateProject,
  updateSessionTitle,
  type CreateHarnessRequest,
  type Harness,
  type Project,
  type Session,
} from "@/lib/api"

export interface HarnessWithSessions extends Harness {
  sessions: Session[]
  expanded: boolean
}

export interface ProjectWithHarnesses extends Project {
  harnesses: HarnessWithSessions[]
  expanded: boolean
}

const EXPANDED_PROJECTS_KEY = "cattery:expanded-projects"
const EXPANDED_HARNESSES_KEY = "cattery:expanded-harnesses"
const CURRENT_PROJECT_KEY = "cattery:current-project"

function readCurrentProject(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(CURRENT_PROJECT_KEY)
  } catch {
    return null
  }
}

function writeCurrentProject(id: string | null) {
  if (typeof window === "undefined") return
  try {
    if (id) window.localStorage.setItem(CURRENT_PROJECT_KEY, id)
    else window.localStorage.removeItem(CURRENT_PROJECT_KEY)
  } catch {
    // Ignore browser storage failures.
  }
}

function readExpandedIds(key: string): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(key)
    const ids = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

function writeExpandedIds(key: string, ids: Set<string>) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]))
  } catch {
    // Ignore browser storage failures; the in-memory state is still correct.
  }
}

function setStoredExpanded(key: string, id: string, expanded: boolean) {
  const ids = readExpandedIds(key)
  if (expanded) ids.add(id)
  else ids.delete(id)
  writeExpandedIds(key, ids)
}

interface WorkspaceStore {
  projects: ProjectWithHarnesses[]
  busySessions: Set<string>
  loaded: boolean
  currentProjectId: string | null
  setCurrentProject: (projectId: string | null) => void
  loadProjects: () => Promise<void>
  toggleProjectExpand: (projectId: string) => void
  toggleHarnessExpand: (harnessId: string) => void
  setHarnessesExpanded: (harnessIds: string[], expanded: boolean) => void
  updateSessionTitle: (sessionId: string, title: string) => void
  createProject: (name: string | null) => Promise<ProjectWithHarnesses>
  renameProject: (projectId: string, name: string) => Promise<Project>
  deleteProject: (projectId: string) => Promise<ProjectWithHarnesses | undefined>
  addHarness: (harness: Harness) => void
  createHarness: (projectId: string, data: CreateHarnessRequest) => Promise<HarnessWithSessions>
  renameHarness: (harnessId: string, name: string) => Promise<Harness>
  renameSession: (sessionId: string, title: string) => Promise<Session>
  createSession: (harness: HarnessWithSessions, theme: "light" | "dark") => Promise<Session>
  deleteHarness: (harnessId: string) => Promise<HarnessWithSessions | undefined>
  deleteSession: (sessionId: string, harnessId: string) => Promise<void>
  refreshSession: (sessionId: string) => Promise<Session>
  pollHarnesses: () => Promise<void>
  setSessionBusy: (sessionId: string, busy: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  projects: [],
  busySessions: new Set(),
  loaded: false,
  currentProjectId: typeof window === "undefined" ? null : readCurrentProject(),

  setCurrentProject: (projectId: string | null) => {
    writeCurrentProject(projectId)
    set({ currentProjectId: projectId })
  },

  loadProjects: async () => {
    const projects = await listProjects()
    const storedProjects = readExpandedIds(EXPANDED_PROJECTS_KEY)
    const storedHarnesses = readExpandedIds(EXPANDED_HARNESSES_KEY)
    const withHarnesses = await Promise.all(
      projects.map(async project => {
        const harnesses = await listHarnesses(project.project_id).catch(() => [])
        const withSessions = await Promise.all(
          harnesses.map(async harness => ({
            harness,
            sessions: await listSessions(harness.harness_id).catch(() => []),
          }))
        )
        return { project, withSessions }
      })
    )
    writeExpandedIds(EXPANDED_PROJECTS_KEY, new Set([...storedProjects].filter(id => projects.some(p => p.project_id === id))))
    const knownHarnessIds = withHarnesses.flatMap(p => p.withSessions.map(h => h.harness.harness_id))
    writeExpandedIds(EXPANDED_HARNESSES_KEY, new Set([...storedHarnesses].filter(id => knownHarnessIds.includes(id))))
    set(state => {
      const nextProjects = withHarnesses.map(({ project, withSessions }) => {
        const existing = state.projects.find(p => p.project_id === project.project_id)
        return {
          ...project,
          expanded: existing?.expanded ?? storedProjects.has(project.project_id),
          harnesses: withSessions.map(({ harness, sessions }) => {
            const existingHarness = existing?.harnesses.find(h => h.harness_id === harness.harness_id)
            return { ...harness, sessions, expanded: existingHarness?.expanded ?? storedHarnesses.has(harness.harness_id) }
          }),
        }
      })
      const stillExists = state.currentProjectId && nextProjects.some(p => p.project_id === state.currentProjectId)
      const nextCurrent = stillExists ? state.currentProjectId : (nextProjects[0]?.project_id ?? null)
      if (nextCurrent !== state.currentProjectId) writeCurrentProject(nextCurrent)
      return {
        loaded: true,
        projects: nextProjects,
        currentProjectId: nextCurrent,
      }
    })
  },

  toggleProjectExpand: (projectId: string) => {
    const project = get().projects.find(p => p.project_id === projectId)
    if (project) setStoredExpanded(EXPANDED_PROJECTS_KEY, projectId, !project.expanded)
    set(state => ({
      projects: state.projects.map(p =>
        p.project_id === projectId ? { ...p, expanded: !p.expanded } : p
      ),
    }))
  },

  toggleHarnessExpand: (harnessId: string) => {
    const harness = findHarness(get().projects, harnessId)?.harness
    if (harness) setStoredExpanded(EXPANDED_HARNESSES_KEY, harnessId, !harness.expanded)
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        harnesses: project.harnesses.map(h =>
          h.harness_id === harnessId ? { ...h, expanded: !h.expanded } : h
        ),
      })),
    }))
  },

  setHarnessesExpanded: (harnessIds: string[], expanded: boolean) => {
    const ids = new Set(harnessIds)
    const stored = readExpandedIds(EXPANDED_HARNESSES_KEY)
    for (const id of ids) {
      if (expanded) stored.add(id)
      else stored.delete(id)
    }
    writeExpandedIds(EXPANDED_HARNESSES_KEY, stored)
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        harnesses: project.harnesses.map(h => ids.has(h.harness_id) ? { ...h, expanded } : h),
      })),
    }))
  },

  createProject: async (name: string | null) => {
    const project = await apiCreateProject({ project_name: name })
    const wrapped: ProjectWithHarnesses = { ...project, harnesses: [], expanded: true }
    setStoredExpanded(EXPANDED_PROJECTS_KEY, project.project_id, true)
    writeCurrentProject(project.project_id)
    set(state => ({
      projects: [wrapped, ...state.projects],
      currentProjectId: project.project_id,
    }))
    return wrapped
  },

  renameProject: async (projectId: string, name: string) => {
    const updated = await updateProject(projectId, { project_name: name })
    set(state => ({
      projects: state.projects.map(p =>
        p.project_id === projectId ? { ...p, project_name: updated.project_name } : p
      ),
    }))
    return updated
  },

  deleteProject: async (projectId: string) => {
    const removed = get().projects.find(p => p.project_id === projectId)
    await apiDeleteProject(projectId)
    setStoredExpanded(EXPANDED_PROJECTS_KEY, projectId, false)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      for (const harness of removed?.harnesses ?? []) {
        for (const session of harness.sessions) nextBusy.delete(session.session_id)
      }
      const nextProjects = state.projects.filter(p => p.project_id !== projectId)
      const nextCurrent = state.currentProjectId === projectId
        ? (nextProjects[0]?.project_id ?? null)
        : state.currentProjectId
      if (nextCurrent !== state.currentProjectId) writeCurrentProject(nextCurrent)
      return {
        busySessions: nextBusy,
        projects: nextProjects,
        currentProjectId: nextCurrent,
      }
    })
    return removed
  },

  createHarness: async (projectId: string, data: CreateHarnessRequest) => {
    const harness = await apiCreateHarness(projectId, data)
    const wrapped: HarnessWithSessions = { ...harness, sessions: [], expanded: false }
    set(state => ({
      projects: state.projects.map(p =>
        p.project_id === projectId
          ? { ...p, harnesses: [wrapped, ...p.harnesses], expanded: true }
          : p
      ),
    }))
    setStoredExpanded(EXPANDED_PROJECTS_KEY, projectId, true)
    return wrapped
  },

  addHarness: (harness: Harness) => {
    set(state => ({
      projects: state.projects.map(p =>
        p.project_id === harness.project_id
          ? { ...p, harnesses: [{ ...harness, sessions: [], expanded: false }, ...p.harnesses] }
          : p
      ),
    }))
  },

  renameHarness: async (harnessId: string, name: string) => {
    const updated = await updateHarness(harnessId, { harness_name: name })
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        harnesses: project.harnesses.map(h =>
          h.harness_id === harnessId ? { ...h, harness_name: updated.harness_name } : h
        ),
      })),
    }))
    return updated
  },

  updateSessionTitle: (sessionId: string, title: string) => {
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        harnesses: project.harnesses.map(h => ({
          ...h,
          sessions: h.sessions.map(s => s.session_id === sessionId ? { ...s, title } : s),
        })),
      })),
    }))
  },

  renameSession: async (sessionId: string, title: string) => {
    const updated = await updateSessionTitle(sessionId, { title })
    get().updateSessionTitle(sessionId, updated.title ?? title)
    return updated
  },

  createSession: async (harness: HarnessWithSessions, theme: "light" | "dark") => {
    const session = await apiCreateSession(harness.harness_id, theme)
    setStoredExpanded(EXPANDED_HARNESSES_KEY, harness.harness_id, true)
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        harnesses: project.harnesses.map(h =>
          h.harness_id === harness.harness_id
            ? { ...h, sessions: [session, ...h.sessions], expanded: true }
            : h
        ),
      })),
    }))
    pollSessionStatus(session.session_id, harness.harness_id)
    return session
  },

  deleteHarness: async (harnessId: string) => {
    const found = findHarness(get().projects, harnessId)
    await apiDeleteHarness(harnessId)
    setStoredExpanded(EXPANDED_HARNESSES_KEY, harnessId, false)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      for (const session of found?.harness.sessions ?? []) {
        nextBusy.delete(session.session_id)
      }
      return {
        busySessions: nextBusy,
        projects: state.projects.map(project => ({
          ...project,
          harnesses: project.harnesses.filter(h => h.harness_id !== harnessId),
        })),
      }
    })
    return found?.harness
  },

  deleteSession: async (sessionId: string, harnessId: string) => {
    await apiDeleteSession(sessionId)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      nextBusy.delete(sessionId)
      return {
        busySessions: nextBusy,
        projects: state.projects.map(project => ({
          ...project,
          harnesses: project.harnesses.map(h =>
            h.harness_id === harnessId
              ? { ...h, sessions: h.sessions.filter(s => s.session_id !== sessionId) }
              : h
          ),
        })),
      }
    })
  },

  refreshSession: async (sessionId: string) => {
    const session = await getSession(sessionId)
    set(state => {
      const nextBusy = new Set(state.busySessions)
      if (session.status === "dead") nextBusy.delete(sessionId)
      return {
        busySessions: nextBusy,
        projects: state.projects.map(project => ({
          ...project,
          harnesses: project.harnesses.map(h =>
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
        })),
      }
    })
    return session
  },

  pollHarnesses: async () => {
    const ids = get().projects
      .flatMap(p => p.harnesses)
      .filter(h => h.sandbox_status !== "ready" && h.sandbox_status !== "failed")
      .map(h => h.harness_id)
    if (ids.length === 0) return
    const updates = await Promise.all(ids.map(id => getHarness(id).catch(() => null)))
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        harnesses: project.harnesses.map(h => {
          const u = updates.find(x => x?.harness_id === h.harness_id)
          return u && u.sandbox_status !== h.sandbox_status
            ? { ...h, sandbox_status: u.sandbox_status }
            : h
        }),
      })),
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
  for (const project of useWorkspaceStore.getState().projects) {
    for (const harness of project.harnesses) {
      const session = harness.sessions.find(s => s.session_id === sessionId)
      if (session) return { session, harness, project }
    }
  }
  return null
}

export function selectHarness(harnessId: string) {
  const found = findHarness(useWorkspaceStore.getState().projects, harnessId)
  return found ? { harness: found.harness, project: found.project } : null
}

function findHarness(projects: ProjectWithHarnesses[], harnessId: string) {
  for (const project of projects) {
    const harness = project.harnesses.find(h => h.harness_id === harnessId)
    if (harness) return { project, harness }
  }
  return null
}

function pollSessionStatus(sessionId: string, harnessId: string) {
  const timer = setInterval(async () => {
    try {
      const updated = await getSession(sessionId)
      if (updated.status !== "creating") clearInterval(timer)
      useWorkspaceStore.setState(state => ({
        projects: state.projects.map(project => ({
          ...project,
          harnesses: project.harnesses.map(h =>
            h.harness_id === harnessId
              ? { ...h, sessions: h.sessions.map(s => s.session_id === sessionId ? updated : s) }
              : h
          ),
        })),
      }))
    } catch {
      clearInterval(timer)
    }
  }, 1500)
}
