"use client"

import { usePathname } from "next/navigation"
import { UserCircle2 } from "lucide-react"
import { ExportMenu } from "@/components/export-menu"
import { ModelIcon } from "@/components/model-icon"
import { useAuthStore } from "@/lib/auth-store"
import { findSession, useWorkspaceStore } from "@/lib/workspace-store"
import { cn } from "@/lib/utils"

function statusDot(status: string): string | null {
  if (status === "ready") return null
  if (status === "failed") return "bg-destructive"
  return "bg-amber-400"
}

export function StatusBar() {
  const pathname = usePathname()
  const user = useAuthStore(s => s.user)

  const sessionId = pathname.startsWith("/sessions/") ? pathname.slice("/sessions/".length) : null
  // Two selectors returning stored references — a selector building a fresh
  // {session, project} object would re-render forever.
  const session = useWorkspaceStore(state => (sessionId ? findSession(state.projects, sessionId)?.session ?? null : null))
  const project = useWorkspaceStore(state => (sessionId ? findSession(state.projects, sessionId)?.project ?? null : null))

  return (
    <footer className="flex h-7 shrink-0 items-center border-t bg-sidebar text-xs">
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 text-muted-foreground">
        <UserCircle2 className="size-3.5" />
        <span className="text-foreground/80">{user?.username ?? "-"}</span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2 px-2">
        {session && project && (
          <>
            {session.title && (
              <>
                <span className="min-w-0 truncate text-foreground/90" title={session.title}>
                  {session.title}
                </span>
                <span className="text-muted-foreground/40">·</span>
              </>
            )}
            <span className="min-w-0 shrink truncate text-muted-foreground">
              {project.project_name ?? "Untitled"}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <ModelIcon id={session.model} className="size-3" />
              <span className="truncate">{session.model}</span>
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground" title="Project sandbox">
              {statusDot(project.sandbox_status) && (
                <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(project.sandbox_status))} />
              )}
              sandbox {project.sandbox_status}
            </span>
            {session.status !== "ready" && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  {statusDot(session.status) && (
                    <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(session.status))} />
                  )}
                  {session.status}
                </span>
              </>
            )}
            <ExportMenu sessionId={session.session_id} />
          </>
        )}
      </div>
    </footer>
  )
}
