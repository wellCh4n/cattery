"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CreateAgentDialog } from "@/components/create-agent-dialog"
import { listAgents, createSession, deleteAgent, type Agent } from "@/lib/api"

export default function AgentsPage() {
  const router = useRouter()
  const [agents, setAgents] = useState<Agent[]>([])
  const [launching, setLaunching] = useState<string | null>(null)

  useEffect(() => {
    listAgents().then(setAgents).catch(console.error)
  }, [])

  async function handleNewSession(agentId: string) {
    setLaunching(agentId)
    try {
      const session = await createSession(agentId)
      router.push(`/sessions/${session.session_id}`)
    } finally {
      setLaunching(null)
    }
  }

  async function handleDelete(agentId: string) {
    await deleteAgent(agentId)
    setAgents(a => a.filter(x => x.agent_id !== agentId))
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agents</h1>
        <CreateAgentDialog onCreated={agent => setAgents(a => [agent, ...a])} />
      </div>

      {agents.length === 0 && (
        <p className="text-muted-foreground text-sm">No agents yet. Create one to get started.</p>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {agents.map(agent => (
          <Card key={agent.agent_id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between">
                <span>{agent.agent_name ?? "Untitled"}</span>
                <Badge variant="outline">{agent.harness_id}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm text-muted-foreground space-y-1">
                <div><span className="font-medium">Model:</span> {agent.model}</div>
                {agent.repo_url && <div><span className="font-medium">Repo:</span> {agent.repo_url}</div>}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={launching === agent.agent_id}
                  onClick={() => handleNewSession(agent.agent_id)}
                >
                  {launching === agent.agent_id ? "Starting..." : "New Session"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleDelete(agent.agent_id)}
                >
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
