"use client"

import { create } from "zustand"
import {
  createProject as apiCreateProject,
  createSession as apiCreateSession,
  deleteProject as apiDeleteProject,
  deleteSession as apiDeleteSession,
  forkSession as apiForkSession,
  getProject,
  getSession,
  isChannelConversation,
  listProjects,
  listSessions,
  updateProject,
  updateSession,
  type Project,
  type Session,
} from "@/lib/api"
import { catalogHas, readLastEffort, readLastModel, useModelsStore, writeLastEffort, writeLastModel } from "@/lib/models"

export interface ProjectWithSessions extends Project {
  sessions: Session[]
}

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

interface WorkspaceStore {
  projects: ProjectWithSessions[]
  busySessions: Set<string>
  loaded: boolean
  currentProjectId: string | null
  setCurrentProject: (projectId: string | null) => void
  loadProjects: () => Promise<void>
  updateSessionTitle: (sessionId: string, title: string) => void
  createProject: (name: string | null) => Promise<ProjectWithSessions>
  renameProject: (projectId: string, name: string) => Promise<Project>
  deleteProject: (projectId: string) => Promise<ProjectWithSessions | undefined>
  renameSession: (sessionId: string, title: string) => Promise<Session>
  // New sessions start on the last model the user picked.
  createSession: (projectId: string) => Promise<Session>
  // Copies a session into a new one owned by the caller (see api.forkSession).
  forkSession: (sessionId: string, before?: string) => Promise<Session>
  setSessionModel: (sessionId: string, model: string) => Promise<Session>
  setSessionEffort: (sessionId: string, effort: string) => Promise<Session>
  applySessionUpdate: (updated: Session) => void
  deleteSession: (sessionId: string) => Promise<void>
  refreshSession: (sessionId: string) => Promise<Session>
  // Rereads a project's session list, for changes missed while not watching it.
  refreshSessions: (projectId: string) => Promise<void>
  // Forgets a session or project deleted elsewhere (or no longer accessible).
  dropSession: (sessionId: string) => void
  dropProject: (projectId: string) => void
  refreshProject: (projectId: string) => Promise<void>
  applySandboxStatus: (projectId: string, status: string) => void
  setSessionBusy: (sessionId: string, busy: boolean) => void
  markSessionActivity: (sessionId: string) => void
}

// mapSessions applies fn to the session list of the project that owns sessionId.
function mapSessions(
  projects: ProjectWithSessions[],
  projectId: string,
  fn: (sessions: Session[]) => Session[],
): ProjectWithSessions[] {
  return projects.map(p => p.project_id === projectId ? { ...p, sessions: fn(p.sessions) } : p)
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
    const withSessions = await Promise.all(
      projects.map(async project => ({
        ...project,
        sessions: await listSessions(project.project_id).catch(() => []),
      })),
    )
    set(state => {
      const stillExists = state.currentProjectId && withSessions.some(p => p.project_id === state.currentProjectId)
      const nextCurrent = stillExists ? state.currentProjectId : (withSessions[0]?.project_id ?? null)
      if (nextCurrent !== state.currentProjectId) writeCurrentProject(nextCurrent)
      return {
        loaded: true,
        projects: withSessions,
        currentProjectId: nextCurrent,
      }
    })
  },

  createProject: async (name: string | null) => {
    const project = await apiCreateProject({ project_name: name })
    const wrapped: ProjectWithSessions = { ...project, sessions: [] }
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
    get().dropProject(projectId)
    return removed
  },

  dropProject: (projectId: string) => {
    set(state => {
      const removed = state.projects.find(p => p.project_id === projectId)
      if (!removed) return state
      const nextBusy = new Set(state.busySessions)
      for (const session of removed.sessions) nextBusy.delete(session.session_id)
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
  },

  updateSessionTitle: (sessionId: string, title: string) => {
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        sessions: project.sessions.map(s => s.session_id === sessionId && !s.title_manual ? { ...s, title } : s),
      })),
    }))
  },

  markSessionActivity: sessionId => {
    const lastSeenAt = new Date().toISOString()
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        sessions: project.sessions.map(session => session.session_id === sessionId
          ? { ...session, last_seen_at: lastSeenAt } : session),
      })),
    }))
  },

  renameSession: async (sessionId: string, title: string) => {
    const updated = await updateSession(sessionId, { title })
    set(state => ({
      projects: mapSessions(state.projects, updated.project_id, sessions =>
        sessions.map(s => s.session_id === sessionId ? { ...s, title: updated.title, title_manual: true } : s),
      ),
    }))
    return updated
  },

  setSessionModel: async (sessionId: string, model: string) => {
    const updated = await updateSession(sessionId, { model })
    writeLastModel(updated.model)
    get().applySessionUpdate(updated)
    return updated
  },

  setSessionEffort: async (sessionId: string, effort: string) => {
    const updated = await updateSession(sessionId, { effort })
    writeLastEffort(updated.effort)
    get().applySessionUpdate(updated)
    return updated
  },

  // A model switch can also change the effort (the new provider may not offer
  // it), so both are taken from the server's answer.
  applySessionUpdate: (updated: Session) => {
    set(state => ({
      projects: mapSessions(state.projects, updated.project_id, sessions =>
        sessions.map(s => s.session_id === updated.session_id ? { ...s, model: updated.model, effort: updated.effort } : s),
      ),
    }))
  },

  createSession: async (projectId: string) => {
    // The last pick may have been dropped from the catalog since; fall back to
    // the default (empty) rather than failing.
    const last = readLastModel()
    const catalog = await useModelsStore.getState().load().catch(() => null)
    const session = await apiCreateSession(projectId, catalog && catalogHas(catalog, last) ? last : "", readLastEffort())
    // Live "session" events carry it on from creating to ready or failed.
    set(state => ({
      projects: mapSessions(state.projects, projectId, sessions =>
        sessions.some(s => s.session_id === session.session_id) ? sessions : [session, ...sessions],
      ),
    }))
    return session
  },

  forkSession: async (sessionId: string, before?: string) => {
    const session = await apiForkSession(sessionId, before)
    set(state => ({
      projects: mapSessions(state.projects, session.project_id, sessions =>
        sessions.some(s => s.session_id === session.session_id) ? sessions : [session, ...sessions],
      ),
    }))
    return session
  },

  deleteSession: async (sessionId: string) => {
    await apiDeleteSession(sessionId)
    get().dropSession(sessionId)
  },

  dropSession: (sessionId: string) => {
    if (!findSession(get().projects, sessionId)) return
    set(state => {
      const nextBusy = new Set(state.busySessions)
      nextBusy.delete(sessionId)
      return {
        busySessions: nextBusy,
        projects: state.projects.map(project => ({
          ...project,
          sessions: project.sessions.filter(s => s.session_id !== sessionId),
        })),
      }
    })
  },

  refreshSession: async (sessionId: string) => {
    // A channel's conversation has no session to reread.
    if (isChannelConversation(sessionId)) throw new Error("not a session")
    const session = await getSession(sessionId)
    set(state => ({
      projects: mapSessions(state.projects, session.project_id, sessions =>
        sessions.some(s => s.session_id === sessionId)
          ? sessions.map(s => s.session_id === sessionId ? session : s)
          : [session, ...sessions],
      ),
    }))
    return session
  },

  refreshSessions: async (projectId: string) => {
    const request = (sessionListRequests.get(projectId) ?? 0) + 1
    sessionListRequests.set(projectId, request)
    const sessions = await listSessions(projectId)
    // A later request answers with newer state; this one is superseded.
    if (sessionListRequests.get(projectId) !== request) return
    set(state => {
      const kept = new Set(sessions.map(s => s.session_id))
      const removed = state.projects.find(p => p.project_id === projectId)?.sessions
        .filter(s => !kept.has(s.session_id) && state.busySessions.has(s.session_id)) ?? []
      let busySessions = state.busySessions
      if (removed.length) {
        busySessions = new Set(busySessions)
        for (const s of removed) busySessions.delete(s.session_id)
      }
      return { busySessions, projects: mapSessions(state.projects, projectId, () => sessions) }
    })
  },

  // refreshProject re-reads a project's sandbox status (sessions untouched).
  refreshProject: async (projectId: string) => {
    const project = await getProject(projectId)
    set(state => ({
      projects: state.projects.map(p =>
        p.project_id === projectId && p.sandbox_status !== project.sandbox_status
          ? { ...p, sandbox_status: project.sandbox_status }
          : p
      ),
    }))
  },

  applySandboxStatus: (projectId: string, status: string) => {
    set(state => ({
      projects: state.projects.map(p =>
        p.project_id === projectId && p.sandbox_status !== status ? { ...p, sandbox_status: status } : p,
      ),
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

// The latest session list request per project, so out-of-order answers are dropped.
const sessionListRequests = new Map<string, number>()

// Sessions are private to their creator; other members follow them read-only.
// Sessions without a creator fall to the project owner. Mirrors the backend's
// canWriteSession.
export function canWriteSession(session: Session, project: Project, userId: string | undefined): boolean {
  if (!userId) return false
  return session.created_by_user_id ? session.created_by_user_id === userId : project.access_role === "owner"
}

export function selectSession(sessionId: string) {
  for (const project of useWorkspaceStore.getState().projects) {
    const session = project.sessions.find(s => s.session_id === sessionId)
    if (session) return { session, project }
  }
  return null
}

// findSession is the selector-friendly variant of selectSession.
export function findSession(projects: ProjectWithSessions[], sessionId: string) {
  for (const project of projects) {
    const session = project.sessions.find(s => s.session_id === sessionId)
    if (session) return { session, project }
  }
  return null
}

