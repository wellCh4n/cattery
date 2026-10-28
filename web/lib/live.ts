"use client"

import { create } from "zustand"
import { liveURL, type SandboxApp } from "@/lib/api"
import { useAppsStore } from "@/lib/apps-store"
import { useMembersStore } from "@/lib/members-store"
import { useInstalledSkillsStore } from "@/lib/skills-store"
import { useProjectTerminalsStore } from "@/lib/terminal-store"
import { useWorkspaceStore } from "@/lib/workspace-store"

// The user's live channel: one WebSocket to /api/v1/live carrying presence and
// project events for the projects this tab watches. Events are current state
// or invalidations, so on every (re)subscribe the client refetches what it
// holds instead of replaying anything.

export interface PresenceUser {
  user_id: string
  username: string
  name: string
  avatar_version: string
}

export type LiveEvent =
  | { type: "presence"; project_id: string; data: { users: PresenceUser[] } }
  | { type: "sandbox"; project_id: string; data: { sandbox_status: string } }
  | { type: "session"; project_id: string; data: SessionChange }
  | { type: "terminals" | "members" | "skills"; project_id: string }
  // The project's listening apps, whole, sent when they change.
  | { type: "apps"; project_id: string; data: { apps: SandboxApp[] } }
  // The user lost access to the project; the server already unsubscribed them.
  | { type: "removed"; project_id: string }

// What happened to a session; "status" (its bringUp progress) also carries the
// new status and phase.
export interface SessionChange {
  session_id: string
  change: "created" | "forked" | "status" | "title" | "settings" | "updated" | "activity" | "deleted"
  status?: string
  phase?: string
}

interface LiveState {
  // Online users per watched project, in arrival order, the caller included.
  presence: Record<string, PresenceUser[]>
}

export const useLiveStore = create<LiveState>(() => ({ presence: {} }))

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15_000
// Refreshes that events trigger wait this long after the last event for the
// key, so a burst (a new session's created → handshake → ready) costs one
// request that already sees the final state. A leading window would still send
// the first event's request and then a second one for the rest.
const COALESCE_MS = 500

// Projects this tab watches, with how many callers watch each.
const watched = new Map<string, number>()
let socket: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_MIN_MS
// Event-triggered refreshes not yet run, by what they refresh.
const pending = new Map<string, ReturnType<typeof setTimeout>>()

// watchProject subscribes to a project's events until the returned function is
// called. The connection opens with the first watcher and closes with the last.
export function watchProject(projectId: string): () => void {
  const count = watched.get(projectId) ?? 0
  watched.set(projectId, count + 1)
  if (count === 0) {
    if (socket?.readyState === WebSocket.OPEN) subscribe(socket, projectId)
    connect()
  }
  return () => {
    const left = (watched.get(projectId) ?? 1) - 1
    if (left > 0) {
      watched.set(projectId, left)
      return
    }
    watched.delete(projectId)
    send({ type: "unsubscribe", project_id: projectId })
    dropPresence(projectId)
    if (watched.size === 0) disconnect()
  }
}

// subscribe starts a project's events, then refetches what this tab holds of
// it: anything that changed while it was not subscribed was missed.
function subscribe(ws: WebSocket, projectId: string) {
  ws.send(JSON.stringify({ type: "subscribe", project_id: projectId }))
  const workspace = useWorkspaceStore.getState()
  void workspace.refreshProject(projectId).catch(() => {})
  void workspace.refreshSessions(projectId).catch(() => {})
  for (const store of [useProjectTerminalsStore, useMembersStore, useInstalledSkillsStore]) reload(store, projectId)
  // The server only sends apps when they change, so a later subscriber reads them.
  if (useAppsStore.getState().projectId === projectId) void useAppsStore.getState().load(projectId)
}

// reload refetches a resource only if this tab has loaded it; the rest load
// fresh when first shown.
interface Reloadable {
  getState(): { entries: Record<string, unknown>; invalidate: (key: string) => Promise<unknown> }
}

function reload(store: Reloadable, key: string) {
  if (store.getState().entries[key]) void store.getState().invalidate(key)
}

function send(msg: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function connect() {
  if (socket || retryTimer) return
  const ws = new WebSocket(liveURL())
  socket = ws
  ws.onopen = () => {
    retryDelay = RETRY_MIN_MS
    for (const projectId of watched.keys()) subscribe(ws, projectId)
  }
  ws.onmessage = e => {
    try { handle(JSON.parse(e.data) as LiveEvent) } catch { /* ignore malformed frames */ }
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    useLiveStore.setState({ presence: {} })
    if (watched.size === 0) return
    retryTimer = setTimeout(() => { retryTimer = null; connect() }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  }
}

function disconnect() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDelay = RETRY_MIN_MS
  const ws = socket
  socket = null
  ws?.close()
  useLiveStore.setState({ presence: {} })
  for (const key of [...pending.keys()]) cancel(key)
}

// later runs refresh once, COALESCE_MS after the last event for key; every
// event that arrives meanwhile restarts the wait.
function later(key: string, refresh: () => void) {
  cancel(key)
  pending.set(key, setTimeout(() => {
    pending.delete(key)
    refresh()
  }, COALESCE_MS))
}

function cancel(key: string) {
  const timer = pending.get(key)
  if (timer) clearTimeout(timer)
  pending.delete(key)
}

function dropPresence(projectId: string) {
  useLiveStore.setState(state => {
    if (!(projectId in state.presence)) return state
    const presence = { ...state.presence }
    delete presence[projectId]
    return { presence }
  })
}

function handle(ev: LiveEvent) {
  if (!watched.has(ev.project_id)) return
  switch (ev.type) {
    case "presence":
      useLiveStore.setState(state => ({ presence: { ...state.presence, [ev.project_id]: ev.data.users } }))
      break
    case "sandbox":
      useWorkspaceStore.getState().applySandboxStatus(ev.project_id, ev.data.sandbox_status)
      break
    // A session change touches one row: a deletion drops it locally, anything
    // else refetches just that session (refreshSession inserts it when new).
    case "session": {
      const { session_id, change } = ev.data
      const key = `session:${session_id}`
      if (change === "deleted") {
        cancel(key)
        useWorkspaceStore.getState().dropSession(session_id)
      } else {
        later(key, () => void useWorkspaceStore.getState().refreshSession(session_id).catch(() => {}))
      }
      break
    }
    case "apps":
      useAppsStore.getState().apply(ev.project_id, ev.data.apps)
      break
    case "terminals":
      later(`terminals:${ev.project_id}`, () => reload(useProjectTerminalsStore, ev.project_id))
      break
    case "members":
      later(`members:${ev.project_id}`, () => reload(useMembersStore, ev.project_id))
      break
    case "skills":
      later(`skills:${ev.project_id}`, () => reload(useInstalledSkillsStore, ev.project_id))
      break
    case "removed":
      dropPresence(ev.project_id)
      useWorkspaceStore.getState().dropProject(ev.project_id)
      break
  }
}
