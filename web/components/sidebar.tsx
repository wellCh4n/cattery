"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Bot,
  ChevronRight,
  Plus,
  Trash2,
  Loader2,
  Cat,
  MessagesSquare,
  Pencil,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CreateAgentDialog } from "@/components/create-agent-dialog"
import { HarnessIcon } from "@/components/harness-icon"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  listAgents,
  listSessions,
  createSession,
  deleteAgent,
  deleteSession,
  getSession,
  updateAgent,
  updateSessionTitle,
  type Agent,
  type Session,
} from "@/lib/api"

interface AgentWithSessions extends Agent {
  sessions: Session[]
  expanded: boolean
}

type DeleteTarget =
  | { kind: "agent"; id: string; name: string }
  | { kind: "session"; id: string; agentId: string }

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const selectedSessionId = pathname.startsWith("/sessions/")
    ? pathname.slice("/sessions/".length)
    : null
  const [agents, setAgents] = useState<AgentWithSessions[]>([])
  const [launching, setLaunching] = useState<string | null>(null)
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState<{ kind: "agent"; id: string; original: string } | { kind: "session"; id: string; original: string } | null>(null)
  const [editValue, setEditValue] = useState("")
  const editInputRef = useRef<HTMLInputElement>(null)

  function startEdit(kind: "agent" | "session", id: string, current: string) {
    setEditing({ kind, id, original: current } as { kind: "agent"; id: string; original: string } | { kind: "session"; id: string; original: string })
    setEditValue(current)
    setTimeout(() => editInputRef.current?.focus(), 0)
  }

  async function commitEdit() {
    if (!editing) return
    const val = editValue.trim()
    if (val === editing.original.trim()) {
      setEditing(null)
      return
    }
    try {
      if (editing.kind === "agent") {
        const updated = await updateAgent(editing.id, { agent_name: val })
        setAgents(prev => prev.map(a => a.agent_id === editing.id ? { ...a, agent_name: updated.agent_name } : a))
      } else {
        const updated = await updateSessionTitle(editing.id, { title: val })
        setAgents(prev => prev.map(a => ({
          ...a,
          sessions: a.sessions.map(s => s.session_id === editing.id ? { ...s, title: updated.title } : s),
        })))
      }
    } catch { /* ignore */ }
    setEditing(null)
  }

  function cancelEdit() {
    setEditing(null)
  }

  function handleEditBlur(related: EventTarget | null) {
    // blur 触发时点击保存按钮的话，让按钮的 onClick 走 commitEdit；
    // 其他点击（含点到 sidebar 外、列表其它项）一律取消编辑。
    if (related instanceof HTMLElement && related.closest("[data-edit-save]")) {
      return
    }
    cancelEdit()
  }

  const loadAgents = useCallback(async () => {
    const list = await listAgents()
    const withSessions = await Promise.all(
      list.map(async a => ({ agent: a, sessions: await listSessions(a.agent_id).catch(() => []) }))
    )
    setAgents(prev =>
      withSessions.map(({ agent, sessions }) => {
        const existing = prev.find(p => p.agent_id === agent.agent_id)
        return { ...agent, sessions, expanded: existing?.expanded ?? true }
      })
    )
  }, [])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    function onTitle(e: Event) {
      const { sessionId, title } = (e as CustomEvent<{ sessionId: string; title: string }>).detail
      setAgents(prev => prev.map(a => ({
        ...a,
        sessions: a.sessions.map(s =>
          s.session_id === sessionId ? { ...s, title } : s
        ),
      })))
    }
    function onBusy(e: Event) {
      const { sessionId, busy } = (e as CustomEvent<{ sessionId: string; busy: boolean }>).detail
      setBusySessions(prev => {
        const next = new Set(prev)
        if (busy) next.add(sessionId); else next.delete(sessionId)
        return next
      })
    }
    window.addEventListener("cattery:title", onTitle)
    window.addEventListener("cattery:session-busy", onBusy)
    return () => {
      window.removeEventListener("cattery:title", onTitle)
      window.removeEventListener("cattery:session-busy", onBusy)
    }
  }, [])

  async function toggleExpand(agentId: string) {
    setAgents(prev => prev.map(a => {
      if (a.agent_id !== agentId) return a
      if (!a.expanded && a.sessions.length === 0) {
        loadSessionsFor(agentId)
      }
      return { ...a, expanded: !a.expanded }
    }))
  }

  async function loadSessionsFor(agentId: string) {
    const sessions = await listSessions(agentId)
    setAgents(prev => prev.map(a =>
      a.agent_id === agentId ? { ...a, sessions, expanded: true } : a
    ))
  }

  async function handleNewSession(agent: AgentWithSessions) {
    setLaunching(agent.agent_id)
    try {
      const session = await createSession(agent.agent_id)
      setAgents(prev => prev.map(a =>
        a.agent_id === agent.agent_id
          ? { ...a, sessions: [session, ...a.sessions], expanded: true }
          : a
      ))
      router.push(`/sessions/${session.session_id}`)
      pollSessionStatus(session.session_id, agent.agent_id)
    } finally {
      setLaunching(null)
    }
  }

  function pollSessionStatus(sessionId: string, agentId: string) {
    const timer = setInterval(async () => {
      try {
        const updated = await getSession(sessionId)
        if (updated.status !== "creating") {
          clearInterval(timer)
        }
        setAgents(prev => prev.map(a =>
          a.agent_id === agentId
            ? { ...a, sessions: a.sessions.map(s => s.session_id === sessionId ? updated : s) }
            : a
        ))
      } catch {
        clearInterval(timer)
      }
    }, 1500)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.kind === "agent") {
        const removed = agents.find(a => a.agent_id === deleteTarget.id)
        await deleteAgent(deleteTarget.id)
        setAgents(prev => prev.filter(a => a.agent_id !== deleteTarget.id))
        if (removed?.sessions.some(s => s.session_id === selectedSessionId)) {
          router.push("/")
        }
      } else {
        await deleteSession(deleteTarget.id)
        setAgents(prev => prev.map(a =>
          a.agent_id === deleteTarget.agentId
            ? { ...a, sessions: a.sessions.filter(s => s.session_id !== deleteTarget.id) }
            : a
        ))
        if (selectedSessionId === deleteTarget.id) {
          router.push("/")
        }
      }
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  function statusDot(status: string) {
    if (status === "ready") return "bg-emerald-500"
    if (status === "failed") return "bg-destructive"
    return "bg-amber-400 animate-pulse"
  }

  // harness id 在创建对话框里有大小写规范的 label（OpenCode / Claude Code / Codex / Hermes），
  // 这里复用同一份映射，避免侧栏显示成全小写的 `opencode` / `claude-code`。
  const HARNESS_LABELS: Record<string, string> = {
    "opencode":    "OpenCode",
    "claude-code": "Claude Code",
    "codex":       "Codex",
    "hermes":      "Hermes",
  }

  // 最近沟通的 session：按 last_seen_at（fallback created_at）倒序，取前 3
  const recentSessions: Array<Session & { agent_name: string | null }> = agents
    .flatMap(a => a.sessions.map(s => ({ ...s, agent_name: a.agent_name })))
    .filter(s => s.status !== "dead")
    .sort((a, b) => {
      const ta = new Date(a.last_seen_at ?? a.created_at).getTime()
      const tb = new Date(b.last_seen_at ?? b.created_at).getTime()
      return tb - ta
    })
    .slice(0, 3)

  return (
    <>
      <aside className="flex flex-col h-full border-r bg-sidebar w-64 shrink-0">
        <header className="flex items-center justify-between px-3 h-12 border-b shrink-0">
          <div className="flex items-center gap-1.5">
            <Cat className="size-4 text-foreground" />
            <span className="font-heading font-semibold text-sm tracking-tight">Cattery</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <CreateAgentDialog
              onCreated={agent =>
                setAgents(prev => [{ ...agent, sessions: [], expanded: true }, ...prev])
              }
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-1.5">
          {recentSessions.length > 0 && (
            <div className="px-1.5 mb-2">
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Recent Sessions
              </div>
              <div className="space-y-0.5">
                {recentSessions.map(sess => (
                  <div
                    key={sess.session_id}
                    role="button"
                    onClick={() => router.push(`/sessions/${sess.session_id}`)}
                    className={cn(
                      "group/recent w-full flex items-center gap-2 text-xs px-2 h-7 rounded-md transition-colors cursor-pointer",
                      "hover:bg-muted text-muted-foreground hover:text-foreground",
                      selectedSessionId === sess.session_id &&
                        "bg-muted text-foreground font-medium"
                    )}
                  >
                    {busySessions.has(sess.session_id) ? (
                      <Loader2 className="size-3 text-amber-500 animate-spin shrink-0" />
                    ) : (
                      <span className={cn("size-1.5 rounded-full shrink-0", statusDot(sess.status))} />
                    )}
                    <span className="truncate flex-1 text-left">
                      {sess.title ?? "New Session"}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0 truncate max-w-[60px]">
                      {sess.agent_name ?? "—"}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mx-2 my-2 border-t border-border/60" />
            </div>
          )}
          {agents.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Bot className="size-8 mx-auto text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground mt-2">No agents yet</p>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                Create one to get started
              </p>
            </div>
          )}
          {agents.map(agent => (
            <div key={agent.agent_id} className="px-1.5 mb-1">
              <div className="group flex items-center gap-0.5 rounded-md pl-1 pr-0.5 h-8 hover:bg-muted transition-colors">
                <button
                  className="flex-1 flex cursor-pointer items-center gap-1.5 min-w-0 h-full text-left text-sm font-medium outline-none"
                  onClick={() => toggleExpand(agent.agent_id)}
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 text-muted-foreground transition-transform shrink-0",
                      agent.expanded && "rotate-90"
                    )}
                  />
                  <HarnessIcon id={agent.harness_id} className="size-3.5 text-muted-foreground shrink-0" />
                  {editing?.kind === "agent" && editing.id === agent.agent_id ? (
                    <Input
                      ref={editInputRef}
                      className="flex-1 h-6 pl-4 pr-2 py-0 text-sm font-medium min-w-0"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") cancelEdit() }}
                      onBlur={e => handleEditBlur(e.relatedTarget)}
                      onClick={e => e.stopPropagation()}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  ) : (
                    <>
                      <span className="truncate min-w-0 flex-1">
                        {agent.agent_name ?? "Untitled"}
                      </span>
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4 px-1.5 font-normal shrink-0 group-hover:hidden"
                      >
                        {HARNESS_LABELS[agent.harness_id] ?? agent.harness_id}
                      </Badge>
                    </>
                  )}
                </button>
                <button
                  className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50 transition-colors"
                  title="New session"
                  disabled={launching === agent.agent_id}
                  onClick={() => handleNewSession(agent)}
                >
                  {launching === agent.agent_id
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Plus className="size-3.5" />}
                </button>
                {editing?.kind === "agent" && editing.id === agent.agent_id ? (
                  <button
                    data-edit-save
                    className="inline-flex cursor-pointer items-center justify-center size-6 rounded text-primary hover:bg-primary/10 transition-colors"
                    title="Save"
                    onClick={commitEdit}
                  >
                    <Check className="size-3.5" />
                  </button>
                ) : (
                  <button
                    className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                    title="Rename"
                    onClick={() => startEdit("agent", agent.agent_id, agent.agent_name ?? "")}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
                <button
                  className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Delete agent"
                  onClick={() => setDeleteTarget({ kind: "agent", id: agent.agent_id, name: agent.agent_name ?? "Untitled" })}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

              {agent.expanded && (
                <div className="ml-3.5 mt-1 border-l border-border/60 pl-1.5 space-y-0.5">
                  {agent.sessions.length === 0 ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
                      <MessagesSquare className="size-3" />
                      <span>No sessions</span>
                    </div>
                  ) : (
                    agent.sessions.map(sess => (
                      <div
                        key={sess.session_id}
                        className={cn(
                          "group/sess w-full flex items-center gap-2 text-xs px-2 h-7 rounded-md transition-colors cursor-pointer",
                          "hover:bg-muted text-muted-foreground hover:text-foreground",
                          selectedSessionId === sess.session_id &&
                            "bg-muted text-foreground font-medium"
                        )}
                        onClick={() => router.push(`/sessions/${sess.session_id}`)}
                      >
                        {busySessions.has(sess.session_id) ? (
                          <Loader2 className="size-3 text-amber-500 animate-spin shrink-0" />
                        ) : (
                          <span className={cn("size-1.5 rounded-full shrink-0", statusDot(sess.status))} />
                        )}
                        {editing?.kind === "session" && editing.id === sess.session_id ? (
                          <Input
                            ref={editInputRef}
                            className="flex-1 h-5 pl-2 pr-2 py-0 text-xs min-w-0"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") cancelEdit() }}
                            onBlur={e => handleEditBlur(e.relatedTarget)}
                            onClick={e => e.stopPropagation()}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                          />
                        ) : (
                          <span className="truncate flex-1">
                            {sess.title ?? "New Session"}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground/70 shrink-0 group-hover/sess:hidden">
                          {new Date(sess.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                        {editing?.kind === "session" && editing.id === sess.session_id ? (
                          <button
                            data-edit-save
                            className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-primary hover:bg-primary/10 transition-colors shrink-0"
                            title="Save"
                            onClick={e => { e.stopPropagation(); commitEdit() }}
                          >
                            <Check className="size-3" />
                          </button>
                        ) : (
                          <button
                            className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
                            title="Rename"
                            onClick={e => { e.stopPropagation(); startEdit("session", sess.session_id, sess.title ?? "") }}
                          >
                            <Pencil className="size-3" />
                          </button>
                        )}
                        <button
                          className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          title="Delete session"
                          onClick={e => {
                            e.stopPropagation()
                            setDeleteTarget({ kind: "session", id: sess.session_id, agentId: agent.agent_id })
                          }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.kind === "agent" ? "Delete agent" : "Delete session"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.kind === "agent"
                ? <>Delete <strong>{deleteTarget.name}</strong> and all its sessions? This will also stop the sandbox.</>
                : "Delete this session? Conversation history will be lost."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
