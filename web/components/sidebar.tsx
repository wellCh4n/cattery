"use client"

import { useState, useEffect, useCallback } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Bot,
  ChevronRight,
  Plus,
  Trash2,
  Loader2,
  Cat,
  MessagesSquare,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CreateAgentDialog } from "@/components/create-agent-dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  listAgents,
  listSessions,
  createSession,
  deleteAgent,
  type Agent,
  type Session,
} from "@/lib/api"

interface AgentWithSessions extends Agent {
  sessions: Session[]
  expanded: boolean
}

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const selectedSessionId = pathname.startsWith("/sessions/")
    ? pathname.slice("/sessions/".length)
    : null
  const [agents, setAgents] = useState<AgentWithSessions[]>([])
  const [launching, setLaunching] = useState<string | null>(null)

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
    } finally {
      setLaunching(null)
    }
  }

  async function handleDelete(agentId: string) {
    if (!confirm("Delete this agent and all its sessions?")) return
    const removed = agents.find(a => a.agent_id === agentId)
    await deleteAgent(agentId)
    setAgents(prev => prev.filter(a => a.agent_id !== agentId))
    if (removed?.sessions.some(s => s.session_id === selectedSessionId)) {
      router.push("/")
    }
  }

  function statusDot(status: string) {
    if (status === "ready") return "bg-emerald-500"
    if (status === "failed") return "bg-destructive"
    return "bg-amber-400 animate-pulse"
  }

  return (
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
                className="flex-1 flex items-center gap-1.5 min-w-0 h-full text-left text-sm font-medium outline-none"
                onClick={() => toggleExpand(agent.agent_id)}
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform shrink-0",
                    agent.expanded && "rotate-90"
                  )}
                />
                <Bot className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate flex-1">
                  {agent.agent_name ?? "Untitled"}
                </span>
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal shrink-0">
                  {agent.harness_id}
                </Badge>
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 inline-flex items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50 transition-colors"
                title="New session"
                disabled={launching === agent.agent_id}
                onClick={() => handleNewSession(agent)}
              >
                {launching === agent.agent_id
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Plus className="size-3.5" />}
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 inline-flex items-center justify-center size-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                title="Delete agent"
                onClick={() => handleDelete(agent.agent_id)}
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
                    <button
                      key={sess.session_id}
                      onClick={() => router.push(`/sessions/${sess.session_id}`)}
                      className={cn(
                        "w-full flex items-center gap-2 text-left text-xs px-2 py-1.5 rounded-md transition-colors",
                        "hover:bg-muted text-muted-foreground hover:text-foreground",
                        selectedSessionId === sess.session_id &&
                          "bg-muted text-foreground font-medium"
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full shrink-0", statusDot(sess.status))} />
                      <span className="truncate font-mono">
                        {sess.session_id.slice(0, 8)}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground/70 shrink-0">
                        {new Date(sess.created_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
