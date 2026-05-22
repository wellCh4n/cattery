"use client"

import { Badge } from "@/components/ui/badge"
import { HarnessIcon } from "@/components/harness-icon"
import { ModelIcon } from "@/components/model-icon"
import { cn } from "@/lib/utils"
import type { Harness } from "@/lib/api"

const TYPE_LABELS: Record<string, string> = {
  "opencode":    "OpenCode",
  "claude-code": "Claude Code",
  "codex":       "Codex",
  "hermes":      "Hermes",
}

function statusBadge(status: string) {
  // mirrors the dot colors used in the left sidebar
  if (status === "ready") return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">ready</Badge>
  if (status === "failed") return <Badge variant="destructive">failed</Badge>
  if (status === "starting") return <Badge className="bg-amber-400/15 text-amber-700 dark:text-amber-400 border-amber-400/30">starting</Badge>
  return <Badge variant="secondary">{status}</Badge>
}

export function HarnessInfoPanel({ harness }: { harness: Harness }) {
  const envEntries = Object.entries(harness.env_vars ?? {})
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 px-3 h-12 border-b shrink-0">
        <HarnessIcon id={harness.type} className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium truncate">
          {harness.harness_name ?? "Untitled"}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
        <Field label="Type">
          <span>{TYPE_LABELS[harness.type] ?? harness.type}</span>
        </Field>
        <Field label="Model">
          <span className="inline-flex items-center gap-1.5">
            <ModelIcon id={harness.model} className="size-3.5" />
            {harness.model}
          </span>
        </Field>
        <Field label="Transport">
          <Badge variant="outline" className="text-[10px] font-normal">
            {harness.transport_kind}
          </Badge>
        </Field>
        <Field label="Sandbox">{statusBadge(harness.sandbox_status)}</Field>
        <Field label="Created">
          <span className="text-muted-foreground">
            {new Date(harness.created_at).toLocaleString()}
          </span>
        </Field>
        <Field label="Harness ID">
          <code className="text-[10px] text-muted-foreground break-all">{harness.harness_id}</code>
        </Field>

        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
            Environment Variables
          </div>
          {envEntries.length === 0 ? (
            <div className="text-muted-foreground/70 italic">(none)</div>
          ) : (
            <div className="rounded-md border divide-y divide-border/60">
              {envEntries.map(([k, v]) => (
                <div key={k} className="px-2 py-1.5">
                  <div className="font-mono text-[11px] font-medium text-foreground/80 break-all">
                    {k}
                  </div>
                  <div className={cn(
                    "font-mono text-[11px] text-muted-foreground break-all whitespace-pre-wrap",
                    "mt-0.5",
                  )}>
                    {v}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <div className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
