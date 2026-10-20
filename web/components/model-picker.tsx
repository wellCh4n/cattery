"use client"

import { useEffect, useState } from "react"
import { DropdownMenu } from "radix-ui"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import { ModelIcon } from "@/components/model-icon"
import { useModelsStore } from "@/lib/models"
import { useWorkspaceStore } from "@/lib/workspace-store"
import { cn } from "@/lib/utils"

interface Props {
  sessionId: string
  model: string
  disabled?: boolean
}

// Switches the session's model. The switch takes effect on the next prompt.
export function ModelPicker({ sessionId, model, disabled }: Props) {
  const catalog = useModelsStore(state => state.catalog)
  const loadModels = useModelsStore(state => state.load)
  const setSessionModel = useWorkspaceStore(state => state.setSessionModel)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadModels().catch(() => {})
  }, [loadModels])

  async function pick(next: string) {
    if (next === model) return
    setSaving(true)
    setError(null)
    try {
      await setSessionModel(sessionId, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch model")
    } finally {
      setSaving(false)
    }
  }

  return (
    <DropdownMenu.Root onOpenChange={open => open && setError(null)}>
      <DropdownMenu.Trigger
        disabled={disabled || saving || !catalog}
        title={error ?? "Switch model"}
        className={cn(
          "inline-flex h-8 max-w-56 cursor-pointer items-center gap-1.5 rounded-full px-2.5 font-mono text-[11px] font-medium text-muted-foreground outline-none transition-colors",
          "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 data-[state=open]:bg-muted data-[state=open]:text-foreground",
          "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
          error && "text-destructive",
        )}
      >
        {saving ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <ModelIcon id={model} className="size-3 shrink-0" />}
        <span className="truncate">{model}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="z-50 min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.RadioGroup value={model} onValueChange={pick}>
            {catalog?.providers.map((provider, i) => (
              <DropdownMenu.Group key={provider.name}>
                {i > 0 && <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />}
                <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                  {provider.name}
                </DropdownMenu.Label>
                {provider.models.map(id => (
                  <DropdownMenu.RadioItem
                    key={id}
                    value={id}
                    className="relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-7 font-mono text-xs outline-none data-[highlighted]:bg-muted"
                  >
                    <ModelIcon id={id} className="size-3.5 shrink-0" />
                    <span className="truncate">{id}</span>
                    <DropdownMenu.ItemIndicator className="absolute right-2 inline-flex">
                      <Check className="size-3.5" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.Group>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
