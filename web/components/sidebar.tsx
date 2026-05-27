"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Bot,
  Cat,
  Check,
  ChevronRight,
  ChevronsUpDown,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  MessagesSquare,
  Pencil,
  Plus,
  Shield,
  Trash2,
  UserCircle2,
  Users,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { CreateHarnessDialog } from "@/components/create-harness-dialog"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import { HarnessIcon } from "@/components/harness-icon"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { ProjectMembersPanel } from "@/components/project-members-panel"
import { RenameSessionDialog } from "@/components/rename-session-dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { type Session } from "@/lib/api"
import { type HarnessWithSessions, type ProjectWithHarnesses, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"

type SidebarView = "harnesses" | "files" | "members"
const VIEW_STORAGE_KEY = "cattery:sidebar:view"

const TYPE_LABELS: Record<string, string> = {
  "opencode":    "OpenCode",
  "claude-code": "Claude Code",
  "codex":       "Codex",
  "hermes":      "Hermes",
}

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const selectedSessionId = pathname.startsWith("/sessions/") ? pathname.slice("/sessions/".length) : null
  const selectedHarnessId = pathname.startsWith("/harnesses/") ? pathname.slice("/harnesses/".length) : null

  const projects = useWorkspaceStore(state => state.projects)
  const currentProjectId = useWorkspaceStore(state => state.currentProjectId)
  const setCurrentProject = useWorkspaceStore(state => state.setCurrentProject)
  const busySessions = useWorkspaceStore(state => state.busySessions)
  const loadProjects = useWorkspaceStore(state => state.loadProjects)
  const pollHarnesses = useWorkspaceStore(state => state.pollHarnesses)
  const toggleHarnessExpand = useWorkspaceStore(state => state.toggleHarnessExpand)
  const addHarness = useWorkspaceStore(state => state.addHarness)
  const createSession = useWorkspaceStore(state => state.createSession)
  const deleteSession = useWorkspaceStore(state => state.deleteSession)
  const deleteProject = useWorkspaceStore(state => state.deleteProject)

  const [launching, setLaunching] = useState<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [createHarnessProject, setCreateHarnessProject] = useState<ProjectWithHarnesses | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ session_id: string; harness_id: string; title: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<Session | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectWithHarnesses | null>(null)
  const projectPickerRef = useRef<HTMLDivElement>(null)

  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const [view, setView] = useState<SidebarView>("harnesses")
  useEffect(() => {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY)
    if (saved === "files" || saved === "harnesses" || saved === "members") setView(saved)
  }, [])
  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

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

  useEffect(() => {
    if (!projectPickerOpen) return
    function onPointerDown(e: PointerEvent) {
      if (projectPickerRef.current && !projectPickerRef.current.contains(e.target as Node)) {
        setProjectPickerOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [projectPickerOpen])

  const { width: sidebarWidth, onMouseDown: onSidebarMouseDown } = useResizable({
    initial: 256,
    min: 240,
    max: 480,
    storageKey: "cattery:sidebar:width",
    side: "right",
  })

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadProjects()
    })
    return () => { cancelled = true }
  }, [loadProjects])

  const currentProject = useMemo(
    () => projects.find(p => p.project_id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )
  const harnesses = currentProject?.harnesses ?? []

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
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Cat className="size-4 shrink-0 text-foreground" />
          <span className="font-heading shrink-0 text-base font-semibold tracking-tight">Cattery</span>
          <div ref={projectPickerRef} className="relative min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setProjectPickerOpen(o => !o)}
              className={cn(
                "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-xs transition-colors",
                "hover:border-border hover:bg-muted",
                projectPickerOpen && "border-border bg-muted",
              )}
              title="Switch project"
            >
              <span className="min-w-0 flex-1 truncate text-left text-foreground/90">
                {currentProject?.project_name ?? (projects.length === 0 ? "No project" : "Untitled")}
              </span>
              <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
            </button>
            {projectPickerOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-[320px] max-h-[60vh] overflow-y-auto rounded-md border bg-popover text-sm shadow-md">
                {projects.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No projects yet</div>
                )}
                {projects.map(project => {
                  const active = project.project_id === currentProjectId
                  const ownsProject = project.access_role === "owner"
                  return (
                    <div
                      key={project.project_id}
                      className={cn(
                        "group/proj flex h-9 cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted",
                        active && "bg-muted/60",
                      )}
                      onClick={() => {
                        setCurrentProject(project.project_id)
                        setProjectPickerOpen(false)
                      }}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
                        {active ? <Check className="size-3.5" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {project.project_name ?? "Untitled"}
                      </span>
                      {!ownsProject && (
                        <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">
                          {project.access_role}
                        </Badge>
                      )}
                      {ownsProject && (
                        <button
                          type="button"
                          title="Delete project"
                          aria-label="Delete project"
                          onClick={e => {
                            e.stopPropagation()
                            setProjectPickerOpen(false)
                            setDeleteProjectTarget(project)
                          }}
                          className="hidden size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive group-hover/proj:inline-flex"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  )
                })}
                <div className="border-t border-border/60" />
                <button
                  type="button"
                  className="flex h-9 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-xs hover:bg-muted"
                  onClick={() => {
                    setProjectPickerOpen(false)
                    setNewProjectOpen(true)
                  }}
                >
                  <Plus className="size-3.5 text-muted-foreground" />
                  New project
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex w-12 shrink-0 flex-col gap-1 border-r py-2">
          <ActivityButton
            icon={<Bot className="size-5" />}
            label="Harnesses"
            active={view === "harnesses"}
            onClick={() => setView("harnesses")}
          />
          <ActivityButton
            icon={<FolderOpen className="size-5" />}
            label="Files"
            active={view === "files"}
            onClick={() => setView("files")}
          />
          <ActivityButton
            icon={<Users className="size-5" />}
            label="Members"
            active={view === "members"}
            onClick={() => setView("members")}
          />
        </div>
        {view === "harnesses" ? (
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Harnesses
          </span>
          {currentProject && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setCreateHarnessProject(currentProject)}
              title="New harness"
            >
              <Plus />
            </Button>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {!currentProject && (
            <div className="px-4 py-8 text-center">
              <Shield className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">No project selected</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">Pick or create one above</p>
            </div>
          )}

          {currentProject && harnesses.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Bot className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">No harnesses yet</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">Create one to get started</p>
            </div>
          )}

          {harnesses.map(harness => (
            <HarnessRow
              key={harness.harness_id}
              harness={harness}
              selected={selectedHarnessId === harness.harness_id}
              selectedSessionId={selectedSessionId}
              launching={launching}
              busySessions={busySessions}
              onToggleExpand={toggleHarnessExpand}
              onNewSession={handleNewSession}
              onRouteSession={id => router.push(`/sessions/${id}`)}
              onRouteHarness={id => router.push(`/harnesses/${id}`)}
              onRequestDeleteSession={(sess, harnessId) => setDeleteSessionTarget({
                session_id: sess.session_id,
                harness_id: harnessId,
                title: sess.title ?? "New Session",
              })}
              onRequestRenameSession={sess => {
                setRenameTarget(sess)
                setRenameOpen(true)
              }}
            />
          ))}
        </div>
        </div>
        ) : view === "files" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            {currentProject ? (
              <FileBrowserPanel
                projectId={currentProject.project_id}
                canWrite={currentProject.access_role !== "viewer"}
              />
            ) : (
              <NoProjectPlaceholder />
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            {currentProject ? (
              <ProjectMembersPanel
                project={currentProject}
                canManage={currentProject.access_role === "owner"}
              />
            ) : (
              <NoProjectPlaceholder />
            )}
          </div>
        )}
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
          <div className="flex h-10 items-center gap-1 pr-1.5">
            <button
              className={cn(
                "flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 transition-colors hover:bg-muted",
                userMenuOpen && "bg-muted",
              )}
              onClick={() => setUserMenuOpen(o => !o)}
            >
              <UserCircle2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left text-xs text-foreground/90">{user?.username ?? "-"}</span>
              {user?.is_admin && (
                <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">admin</Badge>
              )}
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
      />

      {createHarnessProject && (
        <CreateHarnessDialog
          projectId={createHarnessProject.project_id}
          open={true}
          onOpenChange={open => { if (!open) setCreateHarnessProject(null) }}
          onCreated={harness => {
            addHarness(harness)
            setCreateHarnessProject(null)
          }}
        />
      )}

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />

      <RenameSessionDialog
        session={renameTarget}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <ConfirmDialog
        open={deleteSessionTarget !== null}
        onOpenChange={open => { if (!open) setDeleteSessionTarget(null) }}
        title="Delete session?"
        description={
          <>
            <span className="font-medium text-foreground">{deleteSessionTarget?.title}</span>
            {" "}will be permanently deleted along with its transcript. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleteSessionTarget) return
          const target = deleteSessionTarget
          await deleteSession(target.session_id, target.harness_id)
          if (selectedSessionId === target.session_id) {
            router.push(`/harnesses/${target.harness_id}`)
          }
        }}
      />

      <ConfirmDialog
        open={deleteProjectTarget !== null}
        onOpenChange={open => { if (!open) setDeleteProjectTarget(null) }}
        title="Delete project?"
        description={
          <>
            <span className="font-medium text-foreground">{deleteProjectTarget?.project_name ?? "Untitled"}</span>
            {" "}and all its harnesses, sessions, and shared files will be permanently deleted. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleteProjectTarget) return
          const target = deleteProjectTarget
          await deleteProject(target.project_id)
          if (selectedHarnessId && target.harnesses.some(h => h.harness_id === selectedHarnessId)) {
            router.push("/")
          }
          if (selectedSessionId && target.harnesses.some(h => h.sessions.some(s => s.session_id === selectedSessionId))) {
            router.push("/")
          }
        }}
      />
    </>
  )
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

function HarnessRow({
  harness,
  selected,
  selectedSessionId,
  launching,
  busySessions,
  onToggleExpand,
  onNewSession,
  onRouteSession,
  onRouteHarness,
  onRequestDeleteSession,
  onRequestRenameSession,
}: {
  harness: HarnessWithSessions
  selected: boolean
  selectedSessionId: string | null
  launching: string | null
  busySessions: Set<string>
  onToggleExpand: (harnessId: string) => void
  onNewSession: (harness: HarnessWithSessions) => void
  onRouteSession: (sessionId: string) => void
  onRouteHarness: (harnessId: string) => void
  onRequestDeleteSession: (sess: Session, harnessId: string) => void
  onRequestRenameSession: (sess: Session) => void
}) {
  function handleRowClick() {
    onToggleExpand(harness.harness_id)
  }

  function handleChevronClick(e: React.MouseEvent) {
    e.stopPropagation()
    onToggleExpand(harness.harness_id)
  }

  return (
    <div className="mb-1">
      <div
        role="button"
        className={cn(
          "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors select-none",
          selected ? "bg-muted text-foreground" : "hover:bg-muted",
        )}
        onClick={handleRowClick}
        title={harness.expanded ? "Collapse" : "Expand"}
      >
        <button
          type="button"
          className="-ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          onClick={handleChevronClick}
          title={harness.expanded ? "Collapse" : "Expand"}
          aria-label={harness.expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform",
              harness.expanded && "rotate-90",
            )}
          />
        </button>
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5">
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
            {harness.access_role === "owner" ? TYPE_LABELS[harness.type] ?? harness.type : harness.access_role}
          </Badge>
        </div>
        <button
          className={cn(
            "hidden size-5 items-center justify-center rounded transition-colors focus-visible:inline-flex group-hover:inline-flex disabled:cursor-not-allowed disabled:opacity-40",
            canCreateSession(harness)
              ? "cursor-pointer text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              : "cursor-not-allowed text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/40",
          )}
          title={newSessionTitle(harness)}
          disabled={launching === harness.harness_id || !canCreateSession(harness)}
          onClick={e => { e.stopPropagation(); onNewSession(harness) }}
        >
          {launching === harness.harness_id
            ? <Loader2 className="size-3.5 animate-spin" />
            : <Plus className="size-3.5" />}
        </button>
        <button
          className="hidden size-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:inline-flex group-hover:inline-flex"
          title="Harness info"
          onClick={e => { e.stopPropagation(); onRouteHarness(harness.harness_id) }}
        >
          <Info className="size-3.5" />
        </button>
      </div>

      {harness.access_role !== "owner" && (
        <div className="mb-1 ml-8 truncate text-[10px] text-muted-foreground/70">
          {harness.owner_username} · {harness.access_role}
        </div>
      )}

      {harness.expanded && (
        <div className="ml-3.5 mt-0.5 space-y-0.5 border-l border-border/60 pl-1.5">
          {harness.sessions.length === 0 ? (
            <div className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground">
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
                  selectedSessionId === sess.session_id && "bg-muted font-medium text-foreground",
                )}
                onClick={() => onRouteSession(sess.session_id)}
              >
                {busySessions.has(sess.session_id) ? (
                  <Loader2 className="size-3 shrink-0 animate-spin text-amber-500" />
                ) : (
                  <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(sess.status))} />
                )}
                <span className="flex-1 truncate">{sess.title ?? "New Session"}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70 group-hover/sess:hidden">
                  {new Date(sess.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <button
                  type="button"
                  title="Rename session"
                  aria-label="Rename session"
                  onClick={e => {
                    e.stopPropagation()
                    onRequestRenameSession(sess)
                  }}
                  className="hidden size-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground group-hover/sess:inline-flex"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  title="Delete session"
                  aria-label="Delete session"
                  onClick={e => {
                    e.stopPropagation()
                    onRequestDeleteSession(sess, harness.harness_id)
                  }}
                  className="hidden size-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive group-hover/sess:inline-flex"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function NoProjectPlaceholder() {
  return (
    <div className="px-4 py-8 text-center">
      <Shield className="mx-auto size-8 text-muted-foreground/50" />
      <p className="mt-2 text-xs text-muted-foreground">No project selected</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground/70">Pick or create one above</p>
    </div>
  )
}

function ActivityButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 top-1 bottom-1 w-0.5 rounded-r transition-colors",
          active ? "bg-foreground" : "bg-transparent",
        )}
      />
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "flex h-10 w-full cursor-pointer items-center justify-center transition-colors",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
      </button>
    </div>
  )
}
