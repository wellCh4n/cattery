"use client"

// TreeRow + TreeRowAction — shared row chrome for tree-like lists. Used by
// both the session list (sidebar) and the file tree (file browser).
//
// Each tree owns its own data and indent scheme; this primitive just pins
// down the row-level visual chrome (height, gap, hover, selected state) and
// the size-6 hover-revealed action button. That keeps the two trees from
// drifting apart on row chrome without forcing their indent math to match.
// Action buttons reveal on the closest ancestor with `group/treerow`, which
// TreeRow sets — so nested rows don't unmask their parents' actions.

import { forwardRef } from "react"
import { cn } from "@/lib/utils"

// List item backgrounds shared by the side panels and the activity rail, after
// VS Code: a light block on hover, a darker one when selected. Dark mode needs
// a white tint to stand out from the near-black panel.
export const itemHover = "hover:bg-muted-foreground/8 dark:hover:bg-foreground/8"
export const itemSelected = "bg-muted-foreground/15 dark:bg-foreground/20"
// Rows are rounded blocks inset from the panel's edges. The list lays them out
// with `itemList` (a flex column with a matching gap), so the first row starts
// flush under the header, like VS Code's explorer.
export const itemInset = "mx-1.5 rounded-md"
export const itemList = "flex flex-col gap-1.5 px-0 py-0"

interface TreeRowProps extends React.HTMLAttributes<HTMLDivElement> {
  // Currently-selected row in its tree. Adds the standard selected background.
  selected?: boolean
}

export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(
  function TreeRow({ className, selected, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "group/treerow flex h-8 cursor-pointer items-center gap-1.5 text-[13px] transition-colors select-none",
          itemInset,
          selected ? cn(itemSelected, "text-foreground") : itemHover,
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

// Hover-revealed action icon, sized for the size-8 TreeRow. Stays hidden
// until the parent TreeRow is hovered or this button is focused. Pass a
// size-4 lucide icon as the child.
export const TreeRowAction = forwardRef<HTMLButtonElement, TreeRowActionProps>(
  function TreeRowAction({ className, destructive, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors focus-visible:inline-flex group-hover/treerow:inline-flex disabled:cursor-not-allowed disabled:opacity-40",
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
