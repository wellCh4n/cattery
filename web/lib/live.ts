"use client"

import { create } from "zustand"
import { liveURL } from "@/lib/api"
import { useWorkspaceStore } from "@/lib/workspace-store"

// The user's live channel: one WebSocket to /api/v1/live carrying presence and
// project events for the projects this tab watches. Events are current state
// or invalidations, so after a reconnect the client resubscribes and refetches
// instead of replaying anything.

export interface PresenceUser {
  user_id: string
  username: string
  name: string
  avatar_version: string
}

export type LiveEvent =
  | { type: "presence"; project_id: string; data: { users: PresenceUser[] } }
  | { type: "sandbox"; project_id: string; data: { sandbox_status: string } }

interface LiveState {
  // Online users per watched project, in arrival order, the caller included.
  presence: Record<string, PresenceUser[]>
}

export const useLiveStore = create<LiveState>(() => ({ presence: {} }))

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15_000

// Projects this tab watches, with how many callers watch each.
const watched = new Map<string, number>()
let socket: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_MIN_MS

// watchProject subscribes to a project's events until the returned function is
// called. The connection opens with the first watcher and closes with the last.
export function watchProject(projectId: string): () => void {
  const count = watched.get(projectId) ?? 0
  watched.set(projectId, count + 1)
  if (count === 0) {
    send({ type: "subscribe", project_id: projectId })
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

function send(msg: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function connect() {
  if (socket || retryTimer) return
  const ws = new WebSocket(liveURL())
  socket = ws
  ws.onopen = () => {
    retryDelay = RETRY_MIN_MS
    for (const projectId of watched.keys()) {
      ws.send(JSON.stringify({ type: "subscribe", project_id: projectId }))
      // Status changes while disconnected were missed.
      void useWorkspaceStore.getState().refreshProject(projectId).catch(() => {})
    }
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
  }
}
