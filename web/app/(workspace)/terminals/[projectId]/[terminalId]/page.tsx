"use client"

import { use } from "react"
import { Loader2, SquareTerminal } from "lucide-react"
import { useProjectTerminalsStore, useTerminalStore } from "@/lib/terminal-store"
import { Button } from "@/components/ui/button"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  projectId: string
  terminalId: string
}

// The shell itself is drawn by TerminalHost in the workspace layout, over this
// route, so it keeps running while other tabs are open. This page only covers
// the case where the terminal no longer exists.
export default function TerminalPage({ params }: { params: Promise<PageParams> }) {
  const { projectId, terminalId } = use(params)
  const terminal = useTerminalStore(state => state.terminals.find(t => t.terminal_id === terminalId && t.project_id === projectId))
  const resource = useProjectTerminalsStore(state => state.entries[projectId])
  useDocumentTitle(terminal?.title)

  if (terminal) return null
  if (!resource?.data && !resource?.error) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <SquareTerminal className="size-8 text-muted-foreground opacity-50" />
      <p className="mt-2 text-xs text-muted-foreground">{resource?.error || "This terminal was deleted."}</p>
      {resource?.error && <Button className="mt-3" variant="outline" onClick={() => void useProjectTerminalsStore.getState().invalidate(projectId)}>Retry</Button>}
    </div>
  )
}
