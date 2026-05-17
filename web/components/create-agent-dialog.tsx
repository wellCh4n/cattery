"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { createAgent, type Agent } from "@/lib/api"

interface Props {
  onCreated: (agent: Agent) => void
}

export function CreateAgentDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    agent_name: "",
    model: "",
    prompt: "",
    harness_id: "opencode",
    repo_url: "",
    branch: "main",
    container_port: 4096,
    env_vars: "",
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      let env_vars: Record<string, string> = {}
      if (form.env_vars.trim()) {
        for (const line of form.env_vars.split("\n")) {
          const [k, ...v] = line.split("=")
          if (k) env_vars[k.trim()] = v.join("=").trim()
        }
      }
      const agent = await createAgent({
        agent_name: form.agent_name || null,
        model: form.model,
        prompt: form.prompt || null,
        harness_id: form.harness_id,
        repo_url: form.repo_url || null,
        branch: form.branch,
        container_port: form.container_port,
        env_vars,
      })
      onCreated(agent)
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>New Agent</Button>} />
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input placeholder="my-agent" value={form.agent_name} onChange={e => setForm(f => ({ ...f, agent_name: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Model <span className="text-red-500">*</span></Label>
            <Input placeholder="claude-sonnet-4-6" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} required />
          </div>
          <div className="space-y-1">
            <Label>Harness</Label>
            <Input value={form.harness_id} onChange={e => setForm(f => ({ ...f, harness_id: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Repo URL</Label>
            <Input placeholder="https://gitlab.example.com/org/repo.git" value={form.repo_url} onChange={e => setForm(f => ({ ...f, repo_url: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Branch</Label>
            <Input value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>System Prompt</Label>
            <Textarea rows={3} value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>Env Vars (KEY=VALUE, one per line)</Label>
            <Textarea rows={3} placeholder={"API_KEY=xxx\nBASE_URL=https://..."} value={form.env_vars} onChange={e => setForm(f => ({ ...f, env_vars: e.target.value }))} />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Creating..." : "Create"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
