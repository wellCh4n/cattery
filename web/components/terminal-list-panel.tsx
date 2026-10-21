"use client"

// TerminalListPanel — the sidebar's Terminals view: the current project's
// terminals as rows, like sessions (newest first, "New Terminal" until
// renamed). A row opens its terminal as a main-pane tab; deleting it kills its
// tmux session, ending the shell and anything still running in it. Each terminal is a login shell in the project's
// agent container (see TerminalView).

import { useMemo, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Loader2, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react"
import { RenameTerminalDialog } from "@/components/rename-terminal-dialog"
import { Button } from "@/components/ui/button"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { killTerminal } from "@/lib/api"
import { tabForPath, useTabsStore } from "@/lib/tabs-store"
import { type Terminal, type TerminalStatus, useTerminalStore } from "@/lib/terminal-store"
import { cn } from "@/lib/utils"

function statusLabel(status: TerminalStatus | undefined): string {
  if (status === "open") return "running"
  if (status === "connecting") return "connecting"
  if (status === "closed") return "exited"
  return ""
}

export function TerminalListPanel({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const allTerminals = useTerminalStore(state => state.terminals)
  const status = useTerminalStore(state => state.status)
  const createTerminal = useTerminalStore(state => state.createTerminal)
  const removeTerminal = useTerminalStore(state => state.removeTerminal)
  const closeTab = useTabsStore(state => state.closeTab)
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)

  const terminals = useMemo(
    () => allTerminals.filter(t => t.projectId === projectId).reverse(),
    [allTerminals, projectId],
  )
  const route = tabForPath(pathname ?? "")
  const selectedId = route?.kind === "terminal" ? route.id : null

  function open(terminal: Terminal) {
    router.push(`/terminals/${terminal.projectId}/${terminal.id}`)
  }

  function remove(terminal: Terminal) {
    if (selectedId === terminal.id) router.push("/")
    closeTab({ kind: "terminal", id: terminal.id, projectId: terminal.projectId })
    removeTerminal(terminal.id)
    killTerminal(terminal.projectId, terminal.id).catch(err => {
      window.alert(err instanceof Error ? err.message : "Failed to stop the terminal's shell")
    })
  }

  const items: TreeNode[] = terminals.map(terminal => {
    const state = status[terminal.id]
    return {
      id: `t-${terminal.id}`,
      expandable: false,
      selected: selectedId === terminal.id,
      onClick: () => open(terminal),
      body: (
        <>
          {state === "connecting" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <SquareTerminal
              className={cn("size-4 shrink-0", state === "open" ? "text-emerald-500" : "text-muted-foreground")}
            />
          )}
          <span className="flex-1 truncate">{terminal.title}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground/70 group-hover/treerow:hidden">
            {statusLabel(state)}
          </span>
        </>
      ),
      actions: (
        <>
          <TreeRowAction
            title="Rename terminal"
            aria-label="Rename terminal"
            onClick={e => { e.stopPropagation(); setRenameTarget(terminal) }}
          >
            <Pencil className="size-4" />
          </TreeRowAction>
          <TreeRowAction
            destructive
            title="Delete terminal"
            aria-label="Delete terminal"
            onClick={e => { e.stopPropagation(); remove(terminal) }}
          >
            <Trash2 className="size-4" />
          </TreeRowAction>
        </>
      ),
    }
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Terminals</span>
        <Button variant="ghost" size="icon-sm" onClick={() => open(createTerminal(projectId))} title="New terminal (Ctrl+`)">
          <Plus />
        </Button>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {terminals.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <SquareTerminal className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">No terminals</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => open(createTerminal(projectId))}>
              <Plus />
              New terminal
            </Button>
          </div>
        ) : (
          <Tree items={items} />
        )}
      </div>
      {renameTarget && (
        <RenameTerminalDialog key={renameTarget.id} terminal={renameTarget} onClose={() => setRenameTarget(null)} />
      )}
    </div>
  )
}
