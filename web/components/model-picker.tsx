"use client"

import * as React from "react"
import { useEffect, useState } from "react"
import { ChevronDownIcon, Loader2 } from "lucide-react"
import { ModelIcon } from "@/components/model-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroupButton } from "@/components/ui/input-group"
import { effortLabel, providerOf, useModelsStore } from "@/lib/models"
import { useWorkspaceStore } from "@/lib/workspace-store"
import { cn } from "@/lib/utils"

// The two menus of the AI Elements Model Selector: the model the agent runs and
// how hard it thinks. Both switch the session and take effect on the next prompt.

interface Props {
  sessionId: string
  model: string
  effort: string
  disabled?: boolean
  className?: string
}

// useSwitch runs a session update, tracking its pending state and error.
function useSwitch() {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(update: () => Promise<unknown>) {
    setSaving(true)
    setError(null)
    try {
      await update()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch")
    } finally {
      setSaving(false)
    }
  }

  return { saving, error, clearError: () => setError(null), run }
}

function useCatalog() {
  const catalog = useModelsStore(state => state.catalog)
  const load = useModelsStore(state => state.load)
  useEffect(() => {
    void load().catch(() => {})
  }, [load])
  return catalog
}

// Secondary controls beside the composer: small, regular weight and muted until
// hovered or open, so they don't pull attention from the message being written.
const pill = "h-7 rounded-full bg-transparent px-2.5 text-xs font-normal text-muted-foreground hover:border-foreground/30 hover:text-foreground aria-expanded:border-foreground/30 aria-expanded:text-foreground dark:bg-transparent dark:hover:border-foreground/30 dark:aria-expanded:border-foreground/30 [&_svg:not([class*='size-'])]:size-3.5"

// Read-only viewers see the creator's settings as the same pills, without a
// menu: no chevron, and not dimmed like a disabled control.
const staticPill = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground dark:border-input"

export function ModelBadge({ model }: { model: string }) {
  return (
    <span className={cn(staticPill, "min-w-0 max-w-[min(14rem,100%)]")} aria-label={`Model: ${model}`}>
      <ModelIcon id={model} className="size-3.5 shrink-0" />
      <span className="truncate">{model}</span>
    </span>
  )
}

export function EffortBadge({ model, effort }: { model: string; effort: string }) {
  const catalog = useCatalog()
  const provider = catalog ? providerOf(catalog, model) : undefined
  const current = effort || provider?.default_effort || ""
  if (!current) return null
  return <span className={staticPill}>Effort {effortLabel(current)}</span>
}

export function ModelPicker({ sessionId, model, disabled, className }: Omit<Props, "effort">) {
  const catalog = useCatalog()
  const setSessionModel = useWorkspaceStore(state => state.setSessionModel)
  const { saving, error, clearError, run } = useSwitch()

  return (
    <DropdownMenu onOpenChange={open => open && clearError()}>
      <DropdownMenuTrigger
        disabled={disabled || saving || !catalog}
        render={
          <InputGroupButton
            size="sm"
            variant="outline"
            aria-label={`Model: ${model}`}
            title={error ?? model}
            className={cn(pill, "min-w-0 max-w-56 shrink", error && "text-destructive", className)}
          />
        }
      >
        {saving ? <Loader2 className="animate-spin" /> : <ModelIcon id={model} className="size-3.5" />}
        <span className="truncate">{model}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      {/* Items are blocks; space them out like the side panel rows. */}
      <DropdownMenuContent align="start" className="flex w-56 flex-col gap-1 text-xs **:data-[slot=dropdown-menu-radio-item]:text-xs **:data-[slot=dropdown-menu-label]:text-2xs">
        <DropdownMenuRadioGroup
          value={model}
          onValueChange={value => {
            if (value !== model) void run(() => setSessionModel(sessionId, value as string))
          }}
        >
          {catalog?.providers.map((provider, index) => (
            <React.Fragment key={provider.name}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{provider.name}</DropdownMenuLabel>
                {provider.models.map(id => (
                  <DropdownMenuRadioItem key={id} value={id} closeOnClick className="cursor-pointer">
                    <ModelIcon id={id} className="size-3.5" />
                    {id}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function EffortPicker({ sessionId, model, effort, disabled, className }: Props) {
  const catalog = useCatalog()
  const setSessionEffort = useWorkspaceStore(state => state.setSessionEffort)
  const { saving, error, clearError, run } = useSwitch()
  const provider = catalog ? providerOf(catalog, model) : undefined
  // Sessions created before efforts existed have none stored yet.
  const current = effort || provider?.default_effort || ""

  return (
    <DropdownMenu onOpenChange={open => open && clearError()}>
      <DropdownMenuTrigger
        disabled={disabled || saving || !provider}
        render={
          <InputGroupButton
            size="sm"
            variant="outline"
            aria-label={`Effort: ${effortLabel(current)}`}
            title={error ?? undefined}
            className={cn(pill, error && "text-destructive", className)}
          />
        }
      >
        <span>Effort</span>
        <span className="grid text-left">
          {/* Reserve the widest available label even while saving or switching. */}
          {(provider?.efforts ?? []).map(e => (
            <span key={e} aria-hidden="true" className="invisible col-start-1 row-start-1">
              {effortLabel(e)}
            </span>
          ))}
          <span className="col-start-1 row-start-1">{effortLabel(current)}</span>
        </span>
        {saving ? <Loader2 data-icon="inline-end" className="size-4 animate-spin" /> : <ChevronDownIcon data-icon="inline-end" className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36 text-xs **:data-[slot=dropdown-menu-radio-item]:text-xs **:data-[slot=dropdown-menu-label]:text-2xs">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Effort</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={value => {
              if (value !== current) void run(() => setSessionEffort(sessionId, value as string))
            }}
          >
            {provider?.efforts.map(e => (
              <DropdownMenuRadioItem key={e} value={e} closeOnClick className="cursor-pointer">
                {effortLabel(e)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
