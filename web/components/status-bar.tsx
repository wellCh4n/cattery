"use client"

import { usePathname } from "next/navigation"
import { UserCircle2 } from "lucide-react"
import { ExportMenu } from "@/components/export-menu"
import { HarnessIcon } from "@/components/harness-icon"
import { HarnessInfoButton } from "@/components/harness-info-button"
import { ModelIcon } from "@/components/model-icon"
import { useAuthStore } from "@/lib/auth-store"
import { useWorkspaceStore } from "@/lib/workspace-store"
import { cn } from "@/lib/utils"
import type { Harness, Session } from "@/lib/api"

const TYPE_LABELS: Record<string, string> = {
  "opencode":    "OpenCode",
  "claude-code": "Claude Code",
  "codex":       "Codex",
  "hermes":      "Hermes",
}

function statusDot(status: string): string | null {
  if (status === "ready") return null
  if (status === "failed") return "bg-destructive"
  return "bg-amber-400"
}

export function StatusBar() {
  const pathname = usePathname()
  const user = useAuthStore(s => s.user)

  const sessionId = pathname.startsWith("/sessions/") ? pathname.slice("/sessions/".length) : null
  const harnessId = pathname.startsWith("/harnesses/") ? pathname.slice("/harnesses/".length) : null

  const session = useWorkspaceStore<Session | null>(state => {
    if (!sessionId) return null
    for (const project of state.projects) {
      for (const h of project.harnesses) {
        const s = h.sessions.find(s => s.session_id === sessionId)
        if (s) return s
      }
    }
    return null
  })

  const harness = useWorkspaceStore<Harness | null>(state => {
    if (session) {
      for (const project of state.projects) {
        const h = project.harnesses.find(h => h.harness_id === session.harness_id)
        if (h) return h
      }
      return null
    }
    if (!harnessId) return null
    for (const project of state.projects) {
      const h = project.harnesses.find(h => h.harness_id === harnessId)
      if (h) return h
    }
    return null
  })

  return (
    <footer className="flex h-7 shrink-0 items-center border-t bg-sidebar text-xs">
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 text-muted-foreground">
        <UserCircle2 className="size-3.5" />
        <span className="text-foreground/80">{user?.username ?? "-"}</span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2 px-2">
        {harness && (
          <>
            {session?.title && (
              <>
                <span className="min-w-0 truncate text-foreground/90" title={session.title}>
                  {session.title}
                </span>
                <span className="text-muted-foreground/40">·</span>
              </>
            )}
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <HarnessIcon id={harness.type} className="size-3" />
              <span className="truncate">{harness.harness_name ?? "Untitled"}</span>
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span className="shrink-0 text-muted-foreground/80">
              {TYPE_LABELS[harness.type] ?? harness.type}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <ModelIcon id={harness.model} className="size-3" />
              <span className="truncate">{harness.model}</span>
            </span>
            {session && (
              <>
                {statusDot(session.status) && (
                  <span className={cn("ml-1 size-1.5 shrink-0 rounded-full", statusDot(session.status))} />
                )}
                <span className="shrink-0 text-muted-foreground">{session.status}</span>
                <ExportMenu sessionId={session.session_id} />
                <HarnessInfoButton harness={harness} session={session} />
              </>
            )}
          </>
        )}
      </div>
    </footer>
  )
}
