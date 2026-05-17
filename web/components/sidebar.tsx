"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CreateAgentDialog } from "@/components/create-agent-dialog"
import {
  listAgents,
  listSessions,
  createSession,
  deleteAgent,
  type Agent,
  type Session,
} from "@/lib/api"

interface Props {
  selectedSessionId: string | null
  onSelectSession: (session: Session, agent: Agent) => void
}

interface AgentWithSessions extends Agent {
  sessions: Session[]
  expanded: boolean
}

export function Sidebar({ selectedSessionId, onSelectSession }: Props) {
  const [agents, setAgents] = useState<AgentWithSessions[]>([])
  const [launching, setLaunching] = useState<string | null>(null)

  const loadAgents = useCallback(async () => {
    const list = await listAgents()
    setAgents(prev => list.map(a => {
      const existing = prev.find(p => p.agent_id === a.agent_id)
      return { ...a, sessions: existing?.sessions ?? [], expanded: existing?.expanded ?? true }
    }))
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
      const updated = { ...session }
      setAgents(prev => prev.map(a =>
        a.agent_id === agent.agent_id
          ? { ...a, sessions: [updated, ...a.sessions] }
          : a
      ))
      onSelectSession(session, agent)
    } finally {
      setLaunching(null)
    }
  }

  async function handleDelete(agentId: string) {
    await deleteAgent(agentId)
    setAgents(prev => prev.filter(a => a.agent_id !== agentId))
  }

  function statusDot(status: string) {
    if (status === "ready") return "bg-green-500"
    if (status === "failed") return "bg-red-500"
    return "bg-yellow-400 animate-pulse"
  }

  return (
    <div className="flex flex-col h-full border-r w-64 shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="font-semibold text-sm">Cattery</span>
        <CreateAgentDialog onCreated={agent => {
          setAgents(prev => [{ ...agent, sessions: [], expanded: true }, ...prev])
        }} />
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {agents.map(agent => (
          <div key={agent.agent_id}>
            {/* Agent row */}
            <div className="flex items-center gap-1 px-2 py-1 group">
              <button
                className="flex-1 flex items-center gap-2 text-left text-sm font-medium px-2 py-1 rounded hover:bg-muted truncate"
                onClick={() => toggleExpand(agent.agent_id)}
              >
                <span className="text-muted-foreground text-xs">{agent.expanded ? "▾" : "▸"}</span>
                <span className="truncate">{agent.agent_name ?? "Untitled"}</span>
                <Badge variant="outline" className="text-[10px] px-1 py-0 ml-auto shrink-0">
                  {agent.harness_id}
                </Badge>
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-xs px-1 py-1 rounded hover:bg-muted text-muted-foreground"
                title="New session"
                disabled={launching === agent.agent_id}
                onClick={() => handleNewSession(agent)}
              >
                {launching === agent.agent_id ? "…" : "+"}
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-xs px-1 py-1 rounded hover:bg-muted text-red-400"
                title="Delete agent"
                onClick={() => handleDelete(agent.agent_id)}
              >
                ✕
              </button>
            </div>

            {/* Sessions */}
            {agent.expanded && (
              <div className="ml-4">
                {agent.sessions.length === 0 && (
                  <p className="text-xs text-muted-foreground px-4 py-1">No sessions</p>
                )}
                {agent.sessions.map(sess => (
                  <button
                    key={sess.session_id}
                    onClick={() => onSelectSession(sess, agent)}
                    className={`w-full flex items-center gap-2 text-left text-xs px-3 py-1.5 rounded hover:bg-muted truncate ${
                      selectedSessionId === sess.session_id ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(sess.status)}`} />
                    <span className="truncate font-mono">{sess.session_id.slice(0, 8)}…</span>
                    <span className="ml-auto text-muted-foreground shrink-0">
                      {new Date(sess.created_at).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
