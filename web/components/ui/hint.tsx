"use client"

// Hint — the app's hover label, replacing native `title` tooltips so every hint
// uses the shadcn Tooltip. Wraps one element (which must accept a ref and
// props); with no label it renders the element unchanged.

import type { ReactElement, ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function Hint({
  label,
  side,
  children,
}: {
  label: ReactNode
  side?: "top" | "bottom" | "left" | "right"
  children: ReactElement
}) {
  if (label === undefined || label === null || label === "" || label === false) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
