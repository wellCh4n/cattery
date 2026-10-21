"use client"

import { use } from "react"
import { SquareTerminal } from "lucide-react"
import { useTerminalStore } from "@/lib/terminal-store"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  projectId: string
  terminalId: string
}

// The shell itself is drawn by TerminalHost in the workspace layout, over this
// route, so it keeps running while other tabs are open. This page only covers
// the case where the terminal no longer exists.
export default function TerminalPage({ params }: { params: Promise<PageParams> }) {
  const { terminalId } = use(params)
  const terminal = useTerminalStore(state => state.terminals.find(t => t.id === terminalId))
  useDocumentTitle(terminal?.title)

  if (terminal) return null
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <SquareTerminal className="size-8 text-muted-foreground/50" />
      <p className="mt-2 text-xs text-muted-foreground">This terminal was closed.</p>
    </div>
  )
}
