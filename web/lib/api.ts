const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

export interface Agent {
  agent_id: string
  agent_name: string | null
  model: string
  prompt: string | null
  harness_id: string
  repo_url: string | null
  branch: string
  env_vars: Record<string, string>
  container_port: number
  created_at: string
}

export interface Session {
  session_id: string
  agent_id: string
  status: string
  phase: string | null
  title: string | null
  sandbox_url: string | null
  harness_session_id: string | null
  created_at: string
  last_seen_at: string | null
  stopped_at: string | null
}

export async function listAgents(): Promise<Agent[]> {
  const res = await fetch(`${API_BASE}/api/v1/agents`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list agents")
  return res.json()
}

export async function createAgent(data: Omit<Agent, "agent_id" | "created_at">): Promise<Agent> {
  const res = await fetch(`${API_BASE}/api/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to create agent")
  return res.json()
}

export async function deleteAgent(agentId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/agents/${agentId}`, { method: "DELETE" })
}

export async function listSessions(agentId: string): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/api/v1/agents/${agentId}/sessions`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list sessions")
  return res.json()
}

export async function createSession(agentId: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/v1/agents/${agentId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error("failed to create session")
  return res.json()
}

export async function getSession(sessionId: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get session")
  return res.json()
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { method: "DELETE" })
}

export async function abortSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/abort`, { method: "POST" })
}

export interface PlatformHistoryItem {
  messageId: string
  role: "user" | "assistant"
  events: Array<{ type: string; data: Record<string, unknown> }>
}

export async function getHistory(sessionId: string): Promise<PlatformHistoryItem[]> {
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/history`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get history")
  return res.json()
}
