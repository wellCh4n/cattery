"use client"

import { useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import { cn } from "@/lib/utils"
import { createAgent, type Agent } from "@/lib/api"

interface Props {
  onCreated: (agent: Agent) => void
}

const HARNESSES = [
  { id: "opencode",    label: "OpenCode",    available: true  },
  { id: "claude-code", label: "Claude Code", available: true  },
  { id: "codex",       label: "Codex",       available: false },
  { id: "hermes",      label: "Hermes",      available: false },
] as const

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-6",   label: "Opus 4.6"   },
  { id: "claude-opus-4-7",   label: "Opus 4.7"   },
] as const

const defaultForm = {
  agent_name: "",
  model: "claude-sonnet-4-6",
  prompt: "",
  harness_id: "opencode",
  container_port: 4096,
  env_vars: "",
}

export function CreateAgentDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(defaultForm)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
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
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="agent_name">Name</Label>
            <Input
              id="agent_name"
              placeholder="my-agent"
              value={form.agent_name}
              onChange={e => setForm(f => ({ ...f, agent_name: e.target.value }))}
            />
          </div>

          {/* Harness */}
          <div className="space-y-1.5">
            <Label>Harness</Label>
            <div className="grid grid-cols-4 gap-2">
              {HARNESSES.map(h => (
                <button
                  key={h.id}
                  type="button"
                  disabled={!h.available}
                  onClick={() => setForm(f => ({ ...f, harness_id: h.id }))}
                  className={cn(
                    "relative flex cursor-pointer items-center justify-center rounded-lg border px-2 py-3 text-xs font-medium transition-colors outline-none",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    form.harness_id === h.id && h.available
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {h.label}
                  {!h.available && (
                    <Badge variant="outline" className="absolute top-1 right-1 text-[9px] px-1 py-0 h-3.5 font-normal pointer-events-none">
                      soon
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <Label>Model</Label>
            <div className="flex gap-2">
              {MODELS.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, model: m.id }))}
                  className={cn(
                    "flex-1 cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium transition-colors outline-none",
                    form.model === m.id
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* System Prompt */}
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

          {/* Env Vars */}
          <div className="space-y-1.5">
            <Label htmlFor="env_vars">
              Env Vars
              <span className="text-muted-foreground font-normal ml-1">(KEY=VALUE, one per line)</span>
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
            disabled={loading}
          >
            {loading && <Loader2 className="animate-spin" />}
            {loading ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
