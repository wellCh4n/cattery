"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Bot,
  Cat,
  ChevronRight,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  MessagesSquare,
  Plus,
  Shield,
  UserCircle2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { CreateHarnessDialog } from "@/components/create-harness-dialog"
import { HarnessIcon } from "@/components/harness-icon"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { type Session } from "@/lib/api"
import { type HarnessWithSessions, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const selectedSessionId = pathname.startsWith("/sessions/")
    ? pathname.slice("/sessions/".length)
    : null
  const selectedHarnessId = pathname.startsWith("/harnesses/")
    ? pathname.slice("/harnesses/".length)
    : null
  const harnesses = useWorkspaceStore(state => state.harnesses)
  const busySessions = useWorkspaceStore(state => state.busySessions)
  const loadHarnesses = useWorkspaceStore(state => state.loadHarnesses)
  const pollHarnesses = useWorkspaceStore(state => state.pollHarnesses)
  const toggleExpand = useWorkspaceStore(state => state.toggleExpand)
  const addHarness = useWorkspaceStore(state => state.addHarness)
  const createSession = useWorkspaceStore(state => state.createSession)
  const [launching, setLaunching] = useState<string | null>(null)
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

  const { width: sidebarWidth, onMouseDown: onSidebarMouseDown } = useResizable({
    initial: 256,
    min: 200,
    max: 480,
    storageKey: "cattery:sidebar:width",
    side: "right",
  })

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadHarnesses()
    })
    return () => { cancelled = true }
  }, [loadHarnesses])

  const pollingKey = harnesses
    .filter(h => h.sandbox_status !== "ready" && h.sandbox_status !== "failed")
    .map(h => h.harness_id)
    .sort()
    .join(",")

  useEffect(() => {
    if (!pollingKey) return
    const timer = setInterval(() => {
      void pollHarnesses()
    }, 1500)
    return () => clearInterval(timer)
  }, [pollHarnesses, pollingKey])

  async function handleNewSession(harness: HarnessWithSessions) {
    if (!canCreateSession(harness)) return
    setLaunching(harness.harness_id)
    try {
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
      const session = await createSession(harness, theme)
      router.push(`/sessions/${session.session_id}`)
    } finally {
      setLaunching(null)
    }
  }

  function statusDot(status: string) {
    if (status === "ready") return "bg-emerald-500"
    if (status === "failed") return "bg-destructive"
    return "bg-amber-400 animate-pulse"
  }

  function sandboxDot(status: string): string | null {
    if (status === "ready") return null
    if (status === "failed") return "bg-destructive"
    if (status === "starting") return "bg-amber-400 animate-pulse"
    return "bg-muted-foreground/40"
  }

  function canCreateSession(harness: HarnessWithSessions): boolean {
    return harness.sandbox_status === "ready" && harness.access_role !== "viewer"
  }

  function newSessionTitle(harness: HarnessWithSessions): string {
    if (harness.access_role === "viewer") return "Viewer access"
    return canCreateSession(harness) ? "New session" : "Sandbox is not ready"
  }

  const TYPE_LABELS: Record<string, string> = {
    "opencode":    "OpenCode",
    "claude-code": "Claude Code",
    "codex":       "Codex",
    "hermes":      "Hermes",
  }

  const recentSessions: Array<Session & { harness_name: string | null }> = harnesses
    .flatMap(h => h.sessions.map(s => ({ ...s, harness_name: h.harness_name })))
    .filter(s => s.status !== "dead")
    .sort((a, b) => {
      const ta = new Date(a.last_seen_at ?? a.created_at).getTime()
      const tb = new Date(b.last_seen_at ?? b.created_at).getTime()
      return tb - ta
    })
    .slice(0, 3)

  const ownHarnesses = harnesses.filter(h => h.access_role === "owner")
  const sharedHarnesses = harnesses.filter(h => h.access_role !== "owner")

  return (
    <>
      <aside
        className="relative flex h-full shrink-0 flex-col border-r bg-sidebar"
        style={{ width: sidebarWidth }}
      >
        <div
          onMouseDown={onSidebarMouseDown}
          className="absolute right-0 top-0 z-10 h-full w-1 translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/40"
        />
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
          <div className="flex items-center gap-1.5">
            <Cat className="size-4 text-foreground" />
            <span className="font-heading text-base font-semibold tracking-tight">Cattery</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <CreateHarnessDialog onCreated={addHarness} />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-1.5">
          {recentSessions.length > 0 && (
            <div className="mb-2 px-1.5">
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Recent Sessions
              </div>
              <div className="space-y-0.5">
                {recentSessions.map(sess => (
                  <div
                    key={sess.session_id}
                    role="button"
                    onClick={() => router.push(`/sessions/${sess.session_id}`)}
                    className={cn(
                      "group/recent flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-xs transition-colors",
                      "text-muted-foreground hover:bg-muted hover:text-foreground",
                      selectedSessionId === sess.session_id && "bg-muted font-medium text-foreground"
                    )}
                  >
                    {busySessions.has(sess.session_id) ? (
                      <Loader2 className="size-3 shrink-0 animate-spin text-amber-500" />
                    ) : (
                      <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(sess.status))} />
                    )}
                    <span className="flex-1 truncate text-left">{sess.title ?? "New Session"}</span>
                    <span className="max-w-[60px] shrink-0 truncate text-[10px] text-muted-foreground/60">
                      {sess.harness_name ?? "Untitled"}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mx-2 my-2 border-t border-border/60" />
            </div>
          )}

          {harnesses.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Bot className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">No harnesses yet</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">Create one to get started</p>
            </div>
          )}

          <HarnessListSection
            title={sharedHarnesses.length > 0 ? "My Harnesses" : null}
            harnesses={ownHarnesses}
            selectedSessionId={selectedSessionId}
            selectedHarnessId={selectedHarnessId}
            launching={launching}
            busySessions={busySessions}
            typeLabels={TYPE_LABELS}
            onToggleExpand={toggleExpand}
            onNewSession={handleNewSession}
            onRouteSession={id => router.push(`/sessions/${id}`)}
            onRouteHarness={id => router.push(`/harnesses/${id}`)}
            canCreateSession={canCreateSession}
            newSessionTitle={newSessionTitle}
            statusDot={statusDot}
            sandboxDot={sandboxDot}
          />

          <HarnessListSection
            title={sharedHarnesses.length > 0 ? "Shared With Me" : null}
            harnesses={sharedHarnesses}
            selectedSessionId={selectedSessionId}
            selectedHarnessId={selectedHarnessId}
            launching={launching}
            busySessions={busySessions}
            typeLabels={TYPE_LABELS}
            onToggleExpand={toggleExpand}
            onNewSession={handleNewSession}
            onRouteSession={id => router.push(`/sessions/${id}`)}
            onRouteHarness={id => router.push(`/harnesses/${id}`)}
            canCreateSession={canCreateSession}
            newSessionTitle={newSessionTitle}
            statusDot={statusDot}
            sandboxDot={sandboxDot}
          />
        </div>

        <div ref={userMenuRef} className="relative shrink-0 border-t">
          {userMenuOpen && (
            <div className="absolute bottom-full left-1.5 right-1.5 mb-1 overflow-hidden rounded-md border bg-popover text-sm shadow-md">
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
            className={cn(
              "flex h-10 w-full cursor-pointer items-center gap-2 px-2.5 transition-colors hover:bg-muted",
              userMenuOpen && "bg-muted"
            )}
            onClick={() => setUserMenuOpen(o => !o)}
          >
            <UserCircle2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-left text-xs text-foreground/90">{user?.username ?? "-"}</span>
            {user?.is_admin && (
              <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">admin</Badge>
            )}
          </button>
        </div>
      </aside>

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
    </>
  )
}

function HarnessListSection({
  title,
  harnesses,
  selectedSessionId,
  selectedHarnessId,
  launching,
  busySessions,
  typeLabels,
  onToggleExpand,
  onNewSession,
  onRouteSession,
  onRouteHarness,
  canCreateSession,
  newSessionTitle,
  statusDot,
  sandboxDot,
}: {
  title: string | null
  harnesses: HarnessWithSessions[]
  selectedSessionId: string | null
  selectedHarnessId: string | null
  launching: string | null
  busySessions: Set<string>
  typeLabels: Record<string, string>
  onToggleExpand: (harnessId: string) => void
  onNewSession: (harness: HarnessWithSessions) => void
  onRouteSession: (sessionId: string) => void
  onRouteHarness: (harnessId: string) => void
  canCreateSession: (harness: HarnessWithSessions) => boolean
  newSessionTitle: (harness: HarnessWithSessions) => string
  statusDot: (status: string) => string
  sandboxDot: (status: string) => string | null
}) {
  if (harnesses.length === 0) return null
  return (
    <div className="mb-2">
      {title && (
        <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
      )}
      {harnesses.map(harness => (
        <div key={harness.harness_id} className="mb-1 px-1.5">
          <div className={cn(
            "group flex h-8 items-center gap-0.5 rounded-md pl-1 pr-0.5 transition-colors",
            selectedHarnessId === harness.harness_id ? "bg-muted text-foreground" : "hover:bg-muted"
          )}>
            <button
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-sm font-medium outline-none"
              onClick={() => onToggleExpand(harness.harness_id)}
              title={harness.expanded ? "Collapse" : "Expand"}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  harness.expanded && "rotate-90"
                )}
              />
              {sandboxDot(harness.sandbox_status) && (
                <span
                  title={`sandbox: ${harness.sandbox_status}`}
                  className={cn("size-1.5 shrink-0 rounded-full", sandboxDot(harness.sandbox_status))}
                />
              )}
              <HarnessIcon id={harness.type} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{harness.harness_name ?? "Untitled"}</span>
              <Badge
                variant="secondary"
                className="h-4 shrink-0 px-1.5 text-[10px] font-normal group-hover:hidden"
              >
                {harness.access_role === "owner" ? typeLabels[harness.type] ?? harness.type : harness.access_role}
              </Badge>
            </button>
            <button
              className={cn(
                "hidden size-6 items-center justify-center rounded transition-colors focus-visible:inline-flex group-hover:inline-flex disabled:cursor-not-allowed disabled:opacity-40",
                canCreateSession(harness)
                  ? "cursor-pointer text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  : "cursor-not-allowed text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/40"
              )}
              title={newSessionTitle(harness)}
              disabled={launching === harness.harness_id || !canCreateSession(harness)}
              onClick={() => onNewSession(harness)}
            >
              {launching === harness.harness_id
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Plus className="size-3.5" />}
            </button>
            <button
              className="hidden size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:inline-flex group-hover:inline-flex"
              title="Harness info"
              onClick={() => onRouteHarness(harness.harness_id)}
            >
              <Info className="size-3.5" />
            </button>
          </div>

          {harness.access_role !== "owner" && (
            <div className="mb-1 -mt-0.5 ml-8 truncate text-[10px] text-muted-foreground/70">
              {harness.owner_username} · {harness.access_role}
            </div>
          )}

          {harness.expanded && (
            <div className="ml-3.5 mt-1 space-y-0.5 border-l border-border/60 pl-1.5">
              {harness.sessions.length === 0 ? (
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
                  <MessagesSquare className="size-3" />
                  <span>No sessions</span>
                </div>
              ) : (
                harness.sessions.map(sess => (
                  <div
                    key={sess.session_id}
                    className={cn(
                      "group/sess flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-xs transition-colors",
                      "text-muted-foreground hover:bg-muted hover:text-foreground",
                      selectedSessionId === sess.session_id && "bg-muted font-medium text-foreground"
                    )}
                    onClick={() => onRouteSession(sess.session_id)}
                  >
                    {busySessions.has(sess.session_id) ? (
                      <Loader2 className="size-3 shrink-0 animate-spin text-amber-500" />
                    ) : (
                      <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(sess.status))} />
                    )}
                    <span className="flex-1 truncate">{sess.title ?? "New Session"}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {new Date(sess.created_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
