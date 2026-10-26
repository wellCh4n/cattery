"use client"

import { useEffect, useMemo, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Loader2, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react"
import { RenameTerminalDialog } from "@/components/rename-terminal-dialog"
import { Button } from "@/components/ui/button"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { WorkspaceItemBody } from "@/components/workspace-item-body"
import { tabForPath, useTabsStore } from "@/lib/tabs-store"
import { type Terminal, useProjectTerminalsStore, useTerminalStore } from "@/lib/terminal-store"
import { RefreshButton } from "@/components/refresh-button"

export function TerminalListPanel({ projectId, active }: { projectId: string; active: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const allTerminals = useTerminalStore(state => state.terminals)
  const status = useTerminalStore(state => state.status)
  const createTerminal = useTerminalStore(state => state.createTerminal)
  const removeTerminal = useTerminalStore(state => state.removeTerminal)
  const resource = useProjectTerminalsStore(state => state.entries[projectId])
  const closeTab = useTabsStore(state => state.closeTab)
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = !resource?.data && !resource?.error

  // Refetched each time the view is shown, so terminals other members added or
  // removed appear; there is no background polling.
  useEffect(() => {
    if (active) void useProjectTerminalsStore.getState().invalidate(projectId)
  }, [active, projectId])
  const terminals = useMemo(() => allTerminals.filter(t => t.project_id === projectId), [allTerminals, projectId])
  const route = tabForPath(pathname ?? "")
  const selectedId = route?.kind === "terminal" ? route.id : null

  function open(terminal: Terminal) {
    router.push(`/terminals/${terminal.project_id}/${terminal.terminal_id}`)
  }

  async function create() {
    if (creating) return
    setCreating(true)
    setError(null)
    try { open(await createTerminal(projectId)) }
    catch (err) { setError(err instanceof Error ? err.message : "Failed to create terminal") }
    finally { setCreating(false) }
  }

  async function remove(terminal: Terminal) {
    setDeleting(terminal.terminal_id)
    setError(null)
    try {
      await removeTerminal(terminal.terminal_id)
      if (selectedId === terminal.terminal_id) router.push("/")
      closeTab({ kind: "terminal", id: terminal.terminal_id, projectId: terminal.project_id })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete terminal")
    } finally { setDeleting(null) }
  }

  const items: TreeNode[] = terminals.map(terminal => {
    const state = status[terminal.terminal_id]
    return {
      id: `t-${terminal.terminal_id}`,
      expandable: false,
      selected: selectedId === terminal.terminal_id,
      rowClassName: "h-14 items-start py-1.5",
      onClick: () => open(terminal),
      body: (
        <WorkspaceItemBody
          icon={state === "connecting" ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <SquareTerminal className="size-4 text-muted-foreground" />
          )}
          title={terminal.title}
          creator={{ user_id: terminal.created_by_user_id, username: terminal.created_by_username, name: terminal.created_by_name, avatar_version: terminal.created_by_avatar_version }}
          timestamp={terminal.created_at}
          actions={
            <>
              <TreeRowAction aria-label="Rename terminal" onClick={e => { e.stopPropagation(); setRenameTarget(terminal) }}>
                <Pencil className="size-4" />
              </TreeRowAction>
              <TreeRowAction destructive aria-label="Delete terminal" disabled={deleting !== null} onClick={e => { e.stopPropagation(); void remove(terminal) }}>
                {deleting === terminal.terminal_id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              </TreeRowAction>
            </>
          }
        />
      ),
    }
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Terminals</span>
        <div className="flex items-center gap-1">
          <RefreshButton aria-label="Refresh terminals" refreshing={resource?.loading ?? false} onClick={() => { setError(null); void useProjectTerminalsStore.getState().invalidate(projectId) }} />
          <Button variant="ghost" size="icon-sm" onClick={() => void create()} disabled={creating} aria-label="New terminal">
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
        </div>
      </div>
      {(error || resource?.error) && <p className="px-2 py-1 text-xs text-destructive">{error || resource?.error}</p>}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-12 items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : terminals.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <SquareTerminal className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">No terminals</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              New terminal
            </Button>
          </div>
        ) : <Tree items={items} />}
      </div>
      {renameTarget && <RenameTerminalDialog key={renameTarget.terminal_id} terminal={renameTarget} onClose={() => setRenameTarget(null)} />}
    </div>
  )
}
