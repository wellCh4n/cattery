"use client"

import { create } from "zustand"
import {
  abortSession,
  getHistory,
  sendSessionMessageStream,
} from "@/lib/api"
import { refreshFiles, toolChangedDirectories } from "@/lib/files-store"
import { selectSession, useWorkspaceStore } from "@/lib/workspace-store"

export interface MessageDeltaData  { partId: string; text: string }
export interface ToolStartData     { toolId: string; tool: string; input?: string }
export interface ToolDoneData      { toolId: string; tool: string; output?: string; parsed?: unknown }
export interface SessionErrorData  { message: string }
export interface SessionTitleData  { title: string }

export interface Bubble {
  id: string
  role: "user" | "assistant"
  kind: "text" | "thinking" | "tool" | "error"
  content: string
  toolName?: string
  toolStatus?: "pending" | "running" | "completed"
  toolOutput?: string
  toolParsed?: unknown
  done: boolean
}

export interface PlatformEvent {
  type:
    | "message.delta"
    | "message.thinking"
    | "tool.start"
    | "tool.done"
    | "session.idle"
    | "session.error"
    | "session.title"
  data:
    | MessageDeltaData
    | ToolStartData
    | ToolDoneData
    | SessionErrorData
    | SessionTitleData
    | Record<string, never>
}

interface ChatSessionState {
  bubbles: Bubble[]
  sending: boolean
  loaded: boolean
  recovering: boolean
  abortController: AbortController | null
}

interface ChatStreamStore {
  sessions: Record<string, ChatSessionState>
  ensureSession: (sessionId: string) => void
  resetSession: (sessionId: string) => void
  loadHistory: (sessionId: string, refresh?: boolean) => Promise<void>
  sendMessage: (sessionId: string, text: string) => Promise<void>
  stopSession: (sessionId: string) => Promise<void>
  handleEvent: (sessionId: string, ev: PlatformEvent) => void
}

const emptySession = (): ChatSessionState => ({
  bubbles: [],
  sending: false,
  loaded: false,
  recovering: false,
  abortController: null,
})

function restoreHistory(items: Awaited<ReturnType<typeof getHistory>>): Bubble[] {
  const restored: Bubble[] = []
  for (const item of items) {
    if (item.role === "user") {
      const text = item.events
        .filter(e => e.type === "message.delta")
        .map(e => (e.data as { text?: string }).text ?? "")
        .join("")
      if (text) {
        restored.push({
          id: item.messageId,
          role: "user",
          kind: "text",
          content: text,
          done: true,
        })
      }
      continue
    }
    for (const ev of item.events) {
      if (ev.type === "message.delta" || ev.type === "message.thinking") {
        const d = ev.data as { partId?: string; text?: string }
        if (!d.partId || !d.text) continue
        const kind = ev.type === "message.thinking" ? "thinking" : "text"
        const existing = restored.find(b => b.id === d.partId)
        if (existing) {
          existing.content = d.text
        } else {
          restored.push({
            id: d.partId,
            role: "assistant",
            kind,
            content: d.text,
            done: true,
          })
        }
      } else if (ev.type === "tool.start") {
        const d = ev.data as { toolId?: string; tool?: string; input?: string }
        if (!d.toolId) continue
        if (!restored.find(b => b.id === d.toolId)) {
          restored.push({
            id: d.toolId,
            role: "assistant",
            kind: "tool",
            content: d.input ?? "",
            toolName: d.tool,
            toolStatus: "running",
            done: false,
          })
        }
      } else if (ev.type === "tool.done") {
        const d = ev.data as { toolId?: string; output?: string; parsed?: unknown }
        if (!d.toolId) continue
        const existing = restored.find(b => b.id === d.toolId)
        if (existing) {
          existing.toolStatus = "completed"
          existing.toolOutput = d.output ?? ""
          existing.toolParsed = d.parsed
          existing.done = true
        }
      } else if (ev.type === "session.error") {
        const d = ev.data as { message?: string }
        if (!d.message) continue
        restored.push({
          id: `${item.messageId}-err-${restored.length}`,
          role: "assistant",
          kind: "error",
          content: d.message,
          done: true,
        })
      }
    }
  }
  return restored
}

function parseSSELines(buffer: string): { events: PlatformEvent[]; rest: string } {
  const events: PlatformEvent[] = []
  const lines = buffer.split("\n")
  const rest = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data) continue
    try {
      events.push(JSON.parse(data) as PlatformEvent)
    } catch { /* ignore malformed stream frames */ }
  }
  return { events, rest }
}

export const useChatStreamStore = create<ChatStreamStore>((set, get) => ({
  sessions: {},

  ensureSession: (sessionId) => {
    set(state => state.sessions[sessionId]
      ? state
      : { sessions: { ...state.sessions, [sessionId]: emptySession() } }
    )
  },

  resetSession: (sessionId) => {
    const current = get().sessions[sessionId]
    current?.abortController?.abort()
    set(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: emptySession(),
      },
    }))
  },

  loadHistory: async (sessionId, refresh = false) => {
    get().ensureSession(sessionId)
    const existing = get().sessions[sessionId]
    if (existing?.sending || (!refresh && existing?.loaded)) return
    const items = await getHistory(sessionId)
    const restored = restoreHistory(items)
    const recovering = items.some(item => item.events.some(e => e.type === "session.state" && e.data.busy === true))
    if (!recovering) for (const b of restored) b.done = true
    // A send may have started while history was loading.
    if (get().sessions[sessionId] !== existing) return
    useWorkspaceStore.getState().setSessionBusy(sessionId, recovering)
    set(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? emptySession()),
          bubbles: restored,
          recovering,
          sending: false,
          loaded: true,
        },
      },
    }))
  },

  sendMessage: async (sessionId, text) => {
    const current = get().sessions[sessionId]
    if (current?.sending || current?.recovering) return

    const ts = Date.now()
    const ctrl = new AbortController()
    useWorkspaceStore.getState().setSessionBusy(sessionId, true)
    set(state => {
      const session = state.sessions[sessionId] ?? emptySession()
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            loaded: true,
            sending: true,
            recovering: false,
            abortController: ctrl,
            bubbles: [
              ...session.bubbles,
              {
                id: `user-${ts}`,
                role: "user",
                kind: "text",
                content: text,
                done: true,
              },
              {
                id: `pending-${ts}`,
                role: "assistant",
                kind: "text",
                content: "",
                done: false,
              },
            ],
          },
        },
      }
    })

    try {
      const reader = await sendSessionMessageStream(sessionId, text, ctrl.signal)
      // Only accepted messages count as activity; opening a session or a
      // rejected send must not change its ordering.
      useWorkspaceStore.getState().markSessionActivity(sessionId)
      void useWorkspaceStore.getState().refreshSession(sessionId).catch(() => {})
      const decoder = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parsed = parseSSELines(buf)
        buf = parsed.rest
        for (const ev of parsed.events) {
          get().handleEvent(sessionId, ev)
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.name !== "AbortError") {
        useWorkspaceStore.getState().setSessionBusy(sessionId, false)
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...session,
                sending: false,
                abortController: null,
                bubbles: [
                  ...session.bubbles.filter(b => !(b.kind === "text" && !b.done && b.content === "")),
                  {
                    id: `err-${Date.now()}`,
                    role: "assistant",
                    kind: "error",
                    content: e instanceof Error ? e.message : "failed to send message",
                    done: true,
                  },
                ],
              },
            },
          }
        })
      }
    } finally {
      // Sending may have (re)started the project's sandbox; pick up its status.
      const projectId = selectSession(sessionId)?.project.project_id
      if (projectId) void useWorkspaceStore.getState().refreshProject(projectId).catch(() => {})
      let clearedCurrent = false
      set(state => {
        const session = state.sessions[sessionId] ?? emptySession()
        if (session.abortController !== ctrl) return state
        clearedCurrent = true
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              sending: false,
              abortController: null,
            },
          },
        }
      })
      if (clearedCurrent) {
        useWorkspaceStore.getState().setSessionBusy(sessionId, false)
      }
      if (!ctrl.signal.aborted && !get().sessions[sessionId]?.sending) {
        void get().loadHistory(sessionId, true).catch(() => {})
      }
    }
  },

  stopSession: async (sessionId) => {
    get().sessions[sessionId]?.abortController?.abort()
    try {
      await abortSession(sessionId)
    } catch { /* ignore */ }
    set(state => {
      const session = state.sessions[sessionId] ?? emptySession()
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            sending: false,
            recovering: false,
            abortController: null,
            bubbles: session.bubbles
              .filter(b => !(b.kind === "text" && !b.done && b.content === ""))
              .map(b => b.done ? b : { ...b, done: true }),
          },
        },
      }
    })
    useWorkspaceStore.getState().setSessionBusy(sessionId, false)
  },

  handleEvent: (sessionId, ev) => {
    switch (ev.type) {
      case "message.delta": {
        const d = ev.data as MessageDeltaData
        if (!d.text || !d.partId) break
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          const existing = session.bubbles.find(b => b.id === d.partId && b.kind === "text")
          let bubbles: Bubble[]
          if (existing) {
            bubbles = session.bubbles.map(b =>
              b.id === d.partId && b.kind === "text" ? { ...b, content: b.content + d.text } : b
            )
          } else {
            const pendingIdx = session.bubbles.findIndex(b =>
              b.role === "assistant" && b.kind === "text" && !b.done && b.id.startsWith("pending-")
            )
            if (pendingIdx >= 0) {
              bubbles = session.bubbles.map((b, i) => i === pendingIdx ? { ...b, id: d.partId, content: d.text } : b)
            } else {
              bubbles = [...session.bubbles, {
                id: d.partId,
                role: "assistant",
                kind: "text",
                content: d.text,
                done: false,
              }]
            }
          }
          return { sessions: { ...state.sessions, [sessionId]: { ...session, bubbles } } }
        })
        break
      }

      case "message.thinking": {
        const d = ev.data as MessageDeltaData
        if (!d.text || !d.partId) break
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          const existing = session.bubbles.find(b => b.id === d.partId && b.kind === "thinking")
          const bubbles = existing
            ? session.bubbles.map(b => b.id === d.partId && b.kind === "thinking" ? { ...b, content: b.content + d.text } : b)
            : [
                ...session.bubbles.filter(b => !(b.kind === "text" && !b.done && b.content === "")),
                { id: d.partId, role: "assistant" as const, kind: "thinking" as const, content: d.text, done: false },
              ]
          return { sessions: { ...state.sessions, [sessionId]: { ...session, bubbles } } }
        })
        break
      }

      case "tool.start": {
        const d = ev.data as ToolStartData
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          const next = session.bubbles
            .filter(b => !(b.kind === "text" && !b.done && b.content === ""))
            .map(b => (b.kind === "text" || b.kind === "thinking") && !b.done ? { ...b, done: true } : b)
          const existing = next.find(b => b.id === d.toolId)
          const bubbles = existing
            ? next.map(b => b.id === d.toolId ? { ...b, content: d.input ?? b.content } : b)
            : [...next, {
                id: d.toolId,
                role: "assistant" as const,
                kind: "tool" as const,
                content: d.input ?? "",
                toolName: d.tool,
                toolStatus: "running" as const,
                done: false,
              }]
          return { sessions: { ...state.sessions, [sessionId]: { ...session, bubbles } } }
        })
        break
      }

      case "tool.done": {
        const d = ev.data as ToolDoneData
        const tool = get().sessions[sessionId]?.bubbles.find(b => b.id === d.toolId)
        const name = d.tool || tool?.toolName
        const projectId = selectSession(sessionId)?.project.project_id
        if (projectId && name && ["write", "edit", "bash"].includes(name)) {
          // Even a failed tool may have made partial changes. History restoration
          // does not pass through this live-event handler.
          void refreshFiles(projectId, toolChangedDirectories(tool?.content), 150)
        }
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          const bubbles = session.bubbles.map(b =>
            b.id === d.toolId
              ? { ...b, toolStatus: "completed" as const, toolOutput: d.output ?? "", toolParsed: d.parsed, done: true }
              : b
          )
          return { sessions: { ...state.sessions, [sessionId]: { ...session, bubbles } } }
        })
        break
      }

      case "session.idle": {
        const projectId = selectSession(sessionId)?.project.project_id
        if (projectId) void refreshFiles(projectId, [], 150)
        useWorkspaceStore.getState().setSessionBusy(sessionId, false)
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          const bubbles = session.bubbles
            .filter(b => !(b.kind === "text" && !b.done && b.content === ""))
            .map(b => b.done ? b : { ...b, done: true })
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...session, sending: false, abortController: null, bubbles },
            },
          }
        })
        break
      }

      case "session.title": {
        const d = ev.data as SessionTitleData
        if (d.title) {
          useWorkspaceStore.getState().updateSessionTitle(sessionId, d.title)
        }
        break
      }

      case "session.error": {
        const d = ev.data as SessionErrorData
        useWorkspaceStore.getState().setSessionBusy(sessionId, false)
        set(state => {
          const session = state.sessions[sessionId] ?? emptySession()
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...session,
                sending: false,
                abortController: null,
                bubbles: [
                  ...session.bubbles.filter(b => !(b.kind === "text" && !b.done && b.content === "")),
                  {
                    id: `err-${Date.now()}`,
                    role: "assistant",
                    kind: "error",
                    content: d.message,
                    done: true,
                  },
                ],
              },
            },
          }
        })
        break
      }
    }
  },
}))
