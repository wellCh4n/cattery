"use client"

import { create } from "zustand"
import {
  createProject as apiCreateProject,
  createSession as apiCreateSession,
  deleteProject as apiDeleteProject,
  deleteSession as apiDeleteSession,
  getProject,
  getSession,
  listProjects,
  listSessions,
  stopSandbox as apiStopSandbox,
  updateProject,
  updateSession,
  type Project,
  type Session,
} from "@/lib/api"
import { catalogHas, readLastModel, useModelsStore, writeLastModel } from "@/lib/models"

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
  setSessionModel: (sessionId: string, model: string) => Promise<Session>
  deleteSession: (sessionId: string) => Promise<void>
  refreshSession: (sessionId: string) => Promise<Session>
  refreshProject: (projectId: string) => Promise<void>
  stopSandbox: (projectId: string) => Promise<void>
  setSessionBusy: (sessionId: string, busy: boolean) => void
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
    set(state => {
      const nextBusy = new Set(state.busySessions)
      for (const session of removed?.sessions ?? []) nextBusy.delete(session.session_id)
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

  updateSessionTitle: (sessionId: string, title: string) => {
    set(state => ({
      projects: state.projects.map(project => ({
        ...project,
        sessions: project.sessions.map(s => s.session_id === sessionId ? { ...s, title } : s),
      })),
    }))
  },

  renameSession: async (sessionId: string, title: string) => {
    const updated = await updateSession(sessionId, { title })
    get().updateSessionTitle(sessionId, updated.title ?? title)
    return updated
  },

  setSessionModel: async (sessionId: string, model: string) => {
    const updated = await updateSession(sessionId, { model })
    writeLastModel(updated.model)
    set(state => ({
      projects: mapSessions(state.projects, updated.project_id, sessions =>
        sessions.map(s => s.session_id === sessionId ? { ...s, model: updated.model } : s),
      ),
    }))
    return updated
  },

  createSession: async (projectId: string) => {
    // The last pick may have been dropped from the catalog since; fall back to
    // the default (empty) rather than failing.
    const last = readLastModel()
    const catalog = await useModelsStore.getState().load().catch(() => null)
    const session = await apiCreateSession(projectId, catalog && catalogHas(catalog, last) ? last : "")
    set(state => ({
      projects: mapSessions(state.projects, projectId, sessions => [session, ...sessions]),
    }))
    pollSessionStatus(session.session_id, projectId)
    return session
  },

  deleteSession: async (sessionId: string) => {
    await apiDeleteSession(sessionId)
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

  stopSandbox: async (projectId: string) => {
    await apiStopSandbox(projectId)
    set(state => ({
      projects: state.projects.map(p => p.project_id === projectId ? { ...p, sandbox_status: "idle" } : p),
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

function pollSessionStatus(sessionId: string, projectId: string) {
  const timer = setInterval(async () => {
    try {
      const updated = await getSession(sessionId)
      if (updated.status !== "creating") clearInterval(timer)
      useWorkspaceStore.setState(state => ({
        projects: mapSessions(state.projects, projectId, sessions =>
          sessions.map(s => s.session_id === sessionId ? updated : s),
        ),
      }))
      // Creating a session may have started the project's sandbox.
      void useWorkspaceStore.getState().refreshProject(projectId).catch(() => {})
    } catch {
      clearInterval(timer)
    }
  }, 1500)
}
