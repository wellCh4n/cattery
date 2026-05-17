"use client"

import { useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { createAgent, type Agent } from "@/lib/api"

interface Props {
  onCreated: (agent: Agent) => void
}

const defaultForm = {
  agent_name: "",
  model: "",
  prompt: "",
  harness_id: "opencode",
  repo_url: "",
  branch: "main",
  container_port: 4096,
  env_vars: "",
}

export function CreateAgentDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(defaultForm)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const env_vars: Record<string, string> = {}
      if (form.env_vars.trim()) {
        for (const line of form.env_vars.split("\n")) {
          const [k, ...v] = line.split("=")
          if (k.trim()) env_vars[k.trim()] = v.join("=").trim()
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
      setForm(defaultForm)
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="New agent">
            <Plus />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>
            Configure a new agent template. It will run in an isolated Kubernetes sandbox.
          </DialogDescription>
        </DialogHeader>

        <form id="create-agent-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent_name">Name</Label>
              <Input
                id="agent_name"
                placeholder="my-agent"
                value={form.agent_name}
                onChange={e => setForm(f => ({ ...f, agent_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="harness_id">Harness</Label>
              <Input
                id="harness_id"
                value={form.harness_id}
                onChange={e => setForm(f => ({ ...f, harness_id: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model">
              Model <span className="text-destructive">*</span>
            </Label>
            <Input
              id="model"
              placeholder="claude-sonnet-4-6"
              value={form.model}
              onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
              required
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="repo_url">Repo URL</Label>
              <Input
                id="repo_url"
                placeholder="https://gitlab.example.com/org/repo.git"
                value={form.repo_url}
                onChange={e => setForm(f => ({ ...f, repo_url: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="branch">Branch</Label>
              <Input
                id="branch"
                value={form.branch}
                onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prompt">System Prompt</Label>
            <Textarea
              id="prompt"
              rows={3}
              placeholder="You are a helpful coding assistant…"
              value={form.prompt}
              onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="env_vars">
              Env Vars
              <span className="text-muted-foreground font-normal ml-1">
                (KEY=VALUE, one per line)
              </span>
            </Label>
            <Textarea
              id="env_vars"
              rows={3}
              className="font-mono text-xs"
              placeholder={"API_KEY=xxx\nBASE_URL=https://..."}
              value={form.env_vars}
              onChange={e => setForm(f => ({ ...f, env_vars: e.target.value }))}
            />
          </div>
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={loading}>Cancel</Button>} />
          <Button
            type="submit"
            form="create-agent-form"
            disabled={loading || !form.model.trim()}
          >
            {loading && <Loader2 className="animate-spin" />}
            {loading ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
