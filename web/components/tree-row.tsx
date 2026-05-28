"use client"

// TreeRow + TreeRowAction — shared row chrome for tree-like lists. Used by
// both the harness/session tree (sidebar) and the file tree (file browser).
//
// Each tree owns its own data and indent scheme; this primitive just pins
// down the row-level visual chrome (height, gap, hover, selected state) and
// the size-5 hover-revealed action button. That keeps the two trees from
// drifting apart on row chrome without forcing their indent math to match.
// Action buttons reveal on the closest ancestor with `group/treerow`, which
// TreeRow sets — so nested rows don't unmask their parents' actions.

import { forwardRef } from "react"
import { cn } from "@/lib/utils"

interface TreeRowProps extends React.HTMLAttributes<HTMLDivElement> {
  // Currently-selected row in its tree. Adds the standard bg + bold text.
  selected?: boolean
}

export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(
  function TreeRow({ className, selected, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "group/treerow flex h-7 cursor-pointer items-center gap-1 text-xs transition-colors select-none",
          selected ? "bg-muted font-medium text-foreground" : "hover:bg-muted",
          className,
        )}
        {...rest}
      />
    )
  },
)

interface TreeRowActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  destructive?: boolean
}

// Hover-revealed action icon. Sized to match a size-5 chevron / size-3.5
// lucide icon. Stays hidden until the parent TreeRow is hovered or this
// button is focused. Pass a size-3.5 lucide icon as the child.
export const TreeRowAction = forwardRef<HTMLButtonElement, TreeRowActionProps>(
  function TreeRowAction({ className, destructive, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors focus-visible:inline-flex group-hover/treerow:inline-flex disabled:cursor-not-allowed disabled:opacity-40",
          destructive
            ? "hover:bg-destructive/15 hover:text-destructive"
            : "hover:bg-foreground/10 hover:text-foreground",
          className,
        )}
        {...rest}
      />
    )
  },
)
