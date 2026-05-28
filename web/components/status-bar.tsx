"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { KeyRound, LogOut, Shield, UserCircle2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { ExportMenu } from "@/components/export-menu"
import { HarnessIcon } from "@/components/harness-icon"
import { HarnessInfoButton } from "@/components/harness-info-button"
import { ModelIcon } from "@/components/model-icon"
import { ThemeToggle } from "@/components/theme-toggle"
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

function statusDot(status: string): string {
  if (status === "ready") return "bg-emerald-500"
  if (status === "failed") return "bg-destructive"
  return "bg-amber-400"
}

export function StatusBar() {
  const router = useRouter()
  const pathname = usePathname()
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!userMenuOpen) return
    function onPointerDown(e: PointerEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [userMenuOpen])

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
    <>
      <footer className="flex h-7 shrink-0 items-center border-t bg-sidebar text-xs">
        <div ref={userMenuRef} className="relative flex items-center">
          {userMenuOpen && (
            <div className="absolute bottom-full left-0 z-30 mb-1 overflow-hidden rounded-md border bg-popover text-sm shadow-md">
              <button
                className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                onClick={() => { setUserMenuOpen(false); setChangePasswordOpen(true) }}
              >
                <KeyRound className="size-3.5 text-muted-foreground" />
                Change password
              </button>
              {user?.is_admin && (
                <button
                  className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                  onClick={() => { setUserMenuOpen(false); router.push("/admin/users") }}
                >
                  <Shield className="size-3.5 text-muted-foreground" />
                  User management
                </button>
              )}
              <button
                className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-destructive hover:bg-muted"
                onClick={() => { setUserMenuOpen(false); logout() }}
              >
                <LogOut className="size-3.5" />
                Sign out
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setUserMenuOpen(o => !o)}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1.5 px-2.5 hover:bg-muted",
              userMenuOpen && "bg-muted",
            )}
            title="Account"
          >
            <UserCircle2 className="size-3.5 text-muted-foreground" />
            <span className="text-foreground/90">{user?.username ?? "-"}</span>
            {user?.is_admin && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">admin</Badge>
            )}
          </button>
          <ThemeToggle />
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
                  <span className={cn("ml-1 size-1.5 shrink-0 rounded-full", statusDot(session.status))} />
                  <span className="shrink-0 text-muted-foreground">{session.status}</span>
                  <ExportMenu sessionId={session.session_id} />
                  <HarnessInfoButton harness={harness} session={session} />
                </>
              )}
            </>
          )}
        </div>
      </footer>

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
    </>
  )
}
