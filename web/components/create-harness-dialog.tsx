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
import { createHarness, type Harness } from "@/lib/api"
import { HarnessIcon } from "@/components/harness-icon"
import { ModelIcon } from "@/components/model-icon"

interface Props {
  onCreated: (harness: Harness) => void
}

const TYPES = [
  { id: "opencode",    label: "OpenCode",    kind: "chat", available: true },
  { id: "claude-code", label: "Claude Code", kind: "chat", available: true },
  { id: "hermes",      label: "Hermes",      kind: "tui",  available: true },
  { id: "codex",       label: "Codex",       kind: "tui",  available: true },
] as const

interface ModelOption {
  id: string
  label: string
  types: string[]
}

const MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", types: ["opencode", "claude-code", "hermes"] },
  { id: "claude-opus-4-6",   label: "claude-opus-4-6",   types: ["opencode", "claude-code", "hermes"] },
  { id: "claude-opus-4-7",   label: "claude-opus-4-7",   types: ["opencode", "claude-code", "hermes"] },
  { id: "gpt-5.4",           label: "gpt-5.4",           types: ["opencode", "claude-code", "hermes", "codex"] },
  { id: "gpt-5.5",           label: "gpt-5.5",           types: ["opencode", "claude-code", "hermes", "codex"] },
  { id: "__custom__",        label: "Custom",            types: ["opencode", "claude-code", "hermes", "codex"] },
]

const defaultForm = {
  harness_name: "",
  model: "claude-sonnet-4-6",
  custom_model: "",
  type: "opencode",
  env_vars: "",
}

export function CreateHarnessDialog({ onCreated }: Props) {
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
      const model = form.model === "__custom__" ? form.custom_model : form.model
      const harness = await createHarness({
        harness_name: form.harness_name || null,
        model,
        type: form.type,
        env_vars,
      })
      onCreated(harness)
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
          <Button variant="ghost" size="icon-sm" title="New harness">
            <Plus />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Create Harness</DialogTitle>
          <DialogDescription>
            Configure a new harness. It will run in an isolated Kubernetes sandbox.
          </DialogDescription>
        </DialogHeader>

        <form id="create-harness-form" onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="harness_name">Name</Label>
            <Input
              id="harness_name"
              name="harness_name"
              autoComplete="off"
              spellCheck={false}
              value={form.harness_name}
              onChange={e => setForm(f => ({ ...f, harness_name: e.target.value }))}
            />
          </div>

          {/* Type */}
          <div className="space-y-1.5">
            <Label>Type</Label>
            <div className="grid grid-cols-4 gap-2">
              {TYPES.map(t => (
                <button
                  key={t.id}
                  type="button"
                  disabled={!t.available}
                  onClick={() => setForm(f => {
                    const cur = MODELS.find(m => m.id === f.model)
                    const needsReset = cur && !cur.types.includes(t.id)
                    return { ...f, type: t.id, ...(needsReset ? { model: "gpt-5.5" } : {}) }
                  })}
                  className={cn(
                    "relative flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium transition-colors outline-none",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    form.type === t.id && t.available
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  <HarnessIcon id={t.id} className="size-5" />
                  {t.label}
                  <Badge
                    variant="outline"
                    className="absolute top-1 right-1 text-[9px] px-1 py-0 h-3.5 font-normal pointer-events-none uppercase tracking-wide"
                  >
                    {t.kind}
                  </Badge>
                  {!t.available && (
                    <Badge variant="outline" className="absolute top-1 left-1 text-[9px] px-1 py-0 h-3.5 font-normal pointer-events-none">
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
            <div className="grid grid-cols-3 gap-2">
              {MODELS.filter(m => m.types.includes(form.type)).map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, model: m.id }))}
                  className={cn(
                    "relative flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2 font-mono text-xs font-medium transition-colors outline-none",
                    form.model === m.id
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {m.id !== "__custom__" && (
                    <ModelIcon id={m.id} className="absolute left-3 size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{m.label}</span>
                </button>
              ))}
            </div>
            {form.model === "__custom__" && (
              <Input
                className="mt-2 font-mono text-xs"
                placeholder="e.g. gpt-5.5, claude-haiku-4-6"
                autoComplete="off"
                spellCheck={false}
                value={form.custom_model}
                onChange={e => setForm(f => ({ ...f, custom_model: e.target.value }))}
              />
            )}
          </div>

          {/* Env Vars */}
          <div className="space-y-1.5">
            <Label htmlFor="env_vars">
              Env Vars
              <span className="text-muted-foreground font-normal ml-1">(KEY=VALUE, one per line)</span>
            </Label>
            <Textarea
              id="env_vars"
              name="env_vars"
              rows={3}
              className="font-mono text-xs"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={form.env_vars}
              onChange={e => setForm(f => ({ ...f, env_vars: e.target.value }))}
            />
          </div>
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={loading}>Cancel</Button>} />
          <Button
            type="submit"
            form="create-harness-form"
            disabled={loading}
          >
            {loading && <Loader2 className="animate-spin" />}
            {loading ? "Creating…" : "Create harness"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
