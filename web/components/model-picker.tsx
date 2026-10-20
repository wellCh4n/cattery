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
import { useModelsStore } from "@/lib/models"
import { useWorkspaceStore } from "@/lib/workspace-store"
import { cn } from "@/lib/utils"

interface Props {
  sessionId: string
  model: string
  disabled?: boolean
  className?: string
}

// The AI Elements Model Selector: switches the session's model, grouped by
// provider. The switch takes effect on the next prompt.
export function ModelPicker({ sessionId, model, disabled, className }: Props) {
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
    <DropdownMenu onOpenChange={open => open && setError(null)}>
      <DropdownMenuTrigger
        disabled={disabled || saving || !catalog}
        render={
          <InputGroupButton
            size="sm"
            variant="ghost"
            aria-label={`Model: ${model}`}
            title={error ?? undefined}
            className={cn("max-w-56 font-mono text-xs", error && "text-destructive", className)}
          />
        }
      >
        {saving ? <Loader2 className="animate-spin" /> : <ModelIcon id={model} className="size-3.5" />}
        <span className="truncate">{model}</span>
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuRadioGroup value={model} onValueChange={value => void pick(value as string)}>
          {catalog?.providers.map((provider, index) => (
            <React.Fragment key={provider.name}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{provider.name}</DropdownMenuLabel>
                {provider.models.map(id => (
                  <DropdownMenuRadioItem key={id} value={id} closeOnClick className="font-mono text-xs">
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
