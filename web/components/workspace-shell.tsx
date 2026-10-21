"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Check,
  ChevronDown,
  FolderOpen,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Settings,
  Shield,
  Square,
  SquareTerminal,
  Trash2,
  UserCircle2,
  Users,
} from "lucide-react"
import { CatteryLogo } from "@/components/cattery-logo"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import { ModelIcon } from "@/components/model-icon"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { ProjectMembersPanel } from "@/components/project-members-panel"
import { RenameProjectDialog } from "@/components/rename-project-dialog"
import { RenameSessionDialog } from "@/components/rename-session-dialog"
import { SkillBrowserPanel } from "@/components/skill-browser-panel"
import { TerminalListPanel } from "@/components/terminal-list-panel"
import { ThemeToggle } from "@/components/theme-toggle"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { type Session } from "@/lib/api"
import { type ProjectWithSessions, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"
import { compareSessionActivity, sessionActivityTime } from "@/lib/session-activity"

type SidebarView = "sessions" | "terminals" | "files" | "members" | "skills"
const VIEW_STORAGE_KEY = "cattery:sidebar:view"
const MIN_REFRESH_SPIN_MS = 1000

function readSidebarView(): SidebarView {
  if (typeof window === "undefined") return "sessions"
  const saved = localStorage.getItem(VIEW_STORAGE_KEY)
  return saved === "files" || saved === "members" || saved === "sessions" || saved === "skills" || saved === "terminals" ? saved : "sessions"
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const selectedSessionId = pathname.startsWith("/sessions/") ? pathname.slice("/sessions/".length) : null

  const projects = useWorkspaceStore(state => state.projects)
  const currentProjectId = useWorkspaceStore(state => state.currentProjectId)
  const setCurrentProject = useWorkspaceStore(state => state.setCurrentProject)
  const busySessions = useWorkspaceStore(state => state.busySessions)
  const loadProjects = useWorkspaceStore(state => state.loadProjects)
  const refreshProject = useWorkspaceStore(state => state.refreshProject)
  const createSession = useWorkspaceStore(state => state.createSession)
  const deleteSession = useWorkspaceStore(state => state.deleteSession)
  const deleteProject = useWorkspaceStore(state => state.deleteProject)
  const startSandbox = useWorkspaceStore(state => state.startSandbox)
  const stopSandbox = useWorkspaceStore(state => state.stopSandbox)

  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [startingProjects, setStartingProjects] = useState<Set<string>>(() => new Set())
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ session_id: string; title: string } | null>(null)
  const [stopSandboxTarget, setStopSandboxTarget] = useState<ProjectWithSessions | null>(null)
  const [renameTarget, setRenameTarget] = useState<Session | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectWithSessions | null>(null)
  const [renameProjectTarget, setRenameProjectTarget] = useState<ProjectWithSessions | null>(null)
  const projectPickerRef = useRef<HTMLDivElement>(null)

  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const settingsMenuRef = useRef<HTMLDivElement>(null)

  const [view, setView] = useState<SidebarView>(() => readSidebarView())
  const [visitedViews, setVisitedViews] = useState<Set<SidebarView>>(() => new Set([readSidebarView()]))
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

  function switchView(next: SidebarView) {
    setView(next)
    setVisitedViews(prev => prev.has(next) ? prev : new Set(prev).add(next))
  }

  useEffect(() => {
    if (!projectPickerOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setProjectPickerOpen(false)
        projectPickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus()
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (projectPickerRef.current && !projectPickerRef.current.contains(e.target as Node)) {
        setProjectPickerOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [projectPickerOpen])

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
    if (!settingsMenuOpen) return
    function onPointerDown(e: PointerEvent) {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setSettingsMenuOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [settingsMenuOpen])

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
  const sessions = useMemo(() => [...(currentProject?.sessions ?? [])].sort(compareSessionActivity), [currentProject?.sessions])

  // Project controls can start an agent without selecting that project.
  const startingProjectIds = projects.filter(p => p.sandbox_status === "starting").map(p => p.project_id).sort().join(",")
  useEffect(() => {
    if (!startingProjectIds) return
    const timer = setInterval(() => {
      for (const id of startingProjectIds.split(",")) {
        void refreshProject(id).catch(() => {})
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [startingProjectIds, refreshProject])

  async function handleStartProject(projectId: string) {
    setStartingProjects(prev => new Set(prev).add(projectId))
    try {
      await startSandbox(projectId)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to start agent")
    } finally {
      setStartingProjects(prev => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
    }
  }

  // Starts on the last-picked model; it can be switched from the chat.
  const handleCreateSession = useCallback(async () => {
    if (!currentProject || creatingSession) return
    setCreatingSession(true)
    try {
      const session = await createSession(currentProject.project_id)
      router.push(`/sessions/${session.session_id}`)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to create session")
    } finally {
      setCreatingSession(false)
    }
  }, [createSession, creatingSession, currentProject, router])

  async function refreshSessions() {
    setRefreshingSessions(true)
    const startedAt = Date.now()
    try {
      await loadProjects()
    } finally {
      const remaining = MIN_REFRESH_SPIN_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      setRefreshingSessions(false)
    }
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <CatteryLogo className="size-6 shrink-0" />
        <span className="font-heading shrink-0 text-base font-semibold tracking-tight">Cattery</span>
        <div ref={projectPickerRef} className="relative min-w-0 w-44">
          {projects.length === 0 ? (
            <button
              type="button"
              onClick={() => setNewProjectOpen(true)}
              className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Create your first project"
            >
              <Plus className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                Create project
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setProjectPickerOpen(o => !o)}
              aria-expanded={projectPickerOpen}
              className={cn(
                "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs transition-colors",
                projectPickerOpen ? "bg-muted" : "bg-background hover:bg-muted",
              )}
              title="Switch project"
            >
              <span className="shrink-0 text-xs text-muted-foreground">Project</span>
              <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-foreground">
                {currentProject?.project_name ?? "Untitled"}
              </span>
              <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", projectPickerOpen && "rotate-180")} />
            </button>
          )}
          {projectPickerOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-y-auto rounded-lg border bg-popover text-sm shadow-md">
              {projects.map(project => {
                const active = project.project_id === currentProjectId
                const ownsProject = project.access_role === "owner"
                return (
                  <div key={project.project_id}>
                    <div className={cn("flex items-center gap-1 px-2 py-1 transition-colors hover:bg-muted focus-within:bg-muted", active && "bg-muted/60")}>
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        title={project.project_name ?? "Untitled"}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-left"
                        onClick={() => {
                          setCurrentProject(project.project_id)
                          setProjectPickerOpen(false)
                        }}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {active && <Check className="size-3.5 text-primary" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.project_name ?? "Untitled"}</span>
                        {!ownsProject && <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-2xs font-normal">{project.access_role}</Badge>}
                      </button>
                      {ownsProject && (
                        <>
                          <button
                            type="button"
                            aria-label="Rename project"
                            title="Rename project"
                            onClick={() => { setProjectPickerOpen(false); setRenameProjectTarget(project) }}
                            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete project"
                            title="Delete project"
                            onClick={() => { setProjectPickerOpen(false); setDeleteProjectTarget(project) }}
                            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
                      )}
                    </div>
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
                Create project
              </button>
            </div>
          )}
        </div>
        {currentProject && (
          <ProjectRunButton
            project={currentProject}
            starting={startingProjects.has(currentProject.project_id)}
            onStart={() => void handleStartProject(currentProject.project_id)}
            onStop={() => setStopSandboxTarget(currentProject)}
          />
        )}
        <div ref={userMenuRef} className="relative ml-auto shrink-0">
          {userMenuOpen && (
            <div className="absolute right-0 top-full z-30 mt-2 min-w-44 overflow-hidden rounded-lg border bg-popover text-sm shadow-md">
              <div className="border-b px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{user?.username ?? "-"}</span>
                  {user?.is_admin && (
                    <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-2xs font-normal">admin</Badge>
                  )}
                </div>
              </div>
              <button
                className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                onClick={() => { setUserMenuOpen(false); setChangePasswordOpen(true) }}
              >
                <KeyRound className="size-3.5 text-muted-foreground" />
                Change password
              </button>
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
            aria-label="Account"
            aria-expanded={userMenuOpen}
            title={user?.username ?? "Account"}
            onClick={() => { setUserMenuOpen(o => !o); setSettingsMenuOpen(false) }}
            className={cn(
              "flex size-8 cursor-pointer items-center justify-center rounded-full border text-xs font-semibold transition-colors hover:bg-muted",
              userMenuOpen ? "border-primary/40 bg-muted text-foreground" : "border-border bg-background text-muted-foreground",
            )}
          >
            {user?.username?.trim().slice(0, 1).toUpperCase() || <UserCircle2 className="size-5" />}
          </button>
        </div>
      </header>

      {/* Islands layout: the side panel and the main area are rounded cards
          floating on the canvas; header, activity bar and status bar stay flat. */}
      <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5">
        <aside
          className="relative flex h-full shrink-0 flex-col"
          style={{ width: sidebarWidth }}
        >
          <div
            onMouseDown={onSidebarMouseDown}
            className="absolute -right-1.5 top-0 z-10 h-full w-1.5 cursor-col-resize rounded-full transition-colors hover:bg-primary/40"
          />

          <div className="flex min-h-0 flex-1 flex-row">
          <div className="flex w-12 shrink-0 flex-col gap-1">
            <ActivityButton
              icon={<MessagesSquare className="size-5" />}
              label="Sessions"
              active={view === "sessions"}
              onClick={() => switchView("sessions")}
            />
            <ActivityButton
              icon={<SquareTerminal className="size-5" />}
              label="Terminals"
              active={view === "terminals"}
              onClick={() => switchView("terminals")}
            />
            <ActivityButton
              icon={<FolderOpen className="size-5" />}
              label="Files"
              active={view === "files"}
              onClick={() => switchView("files")}
            />
            <ActivityButton
              icon={<Users className="size-5" />}
              label="Members"
              active={view === "members"}
              onClick={() => switchView("members")}
            />
            <ActivityButton
              icon={<Puzzle className="size-5" />}
              label="Skills"
              active={view === "skills"}
              onClick={() => switchView("skills")}
            />

            <div className="mt-auto flex flex-col gap-1">
              <div ref={settingsMenuRef} className="relative">
                {settingsMenuOpen && (
                  <div className="absolute bottom-0 left-full z-30 ml-1 min-w-44 overflow-hidden rounded-lg border bg-popover text-sm shadow-md">
                    {user?.is_admin && (
                      <button
                        className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                        onClick={() => { setSettingsMenuOpen(false); router.push("/admin/users") }}
                      >
                        <Shield className="size-3.5 text-muted-foreground" />
                        User management
                      </button>
                    )}
                    <div className="flex h-8 items-center justify-between gap-2 px-2.5">
                      <span className="text-muted-foreground">Theme</span>
                      <ThemeToggle />
                    </div>
                  </div>
                )}
                <RailButton
                  icon={<Settings className="size-5" />}
                  label="Settings"
                  active={settingsMenuOpen}
                  onClick={() => { setSettingsMenuOpen(o => !o); setUserMenuOpen(false) }}
                />
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-background">
          <div className={cn("min-h-0 min-w-0 flex-1 flex-col", view === "sessions" ? "flex" : "hidden")}>
          {currentProject && (
            <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
              <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Sessions
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={refreshSessions}
                  disabled={refreshingSessions}
                  title="Refresh sessions"
                >
                  <RefreshCw className={refreshingSessions ? "animate-spin" : undefined} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCreateSession}
                  disabled={creatingSession}
                  title="New session"
                >
                  {creatingSession ? <Loader2 className="animate-spin" /> : <Plus />}
                </Button>
              </div>
            </div>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {!currentProject && (
              <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                <FolderOpen className="size-8 text-muted-foreground/50" />
                <p className="mt-2 text-xs text-muted-foreground">No project selected</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setNewProjectOpen(true)}
                >
                  <Plus />
                  Create project
                </Button>
              </div>
            )}

            {currentProject && sessions.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                <MessagesSquare className="size-8 text-muted-foreground/50" />
                <p className="mt-2 text-xs text-muted-foreground">No sessions</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={handleCreateSession}
                  disabled={creatingSession}
                >
                  {creatingSession ? <Loader2 className="animate-spin" /> : <Plus />}
                  New session
                </Button>
              </div>
            )}

            <Tree
              items={sessions.map(sess => buildSessionNode({
                session: sess,
                selected: selectedSessionId === sess.session_id,
                busy: busySessions.has(sess.session_id),
                onRoute: id => router.push(`/sessions/${id}`),
                onRequestDelete: s => setDeleteSessionTarget({
                  session_id: s.session_id,
                  title: s.title ?? "New Session",
                }),
                onRequestRename: s => {
                  setRenameTarget(s)
                  setRenameOpen(true)
                },
              }))}
            />
          </div>
          </div>
          <div className={cn("min-h-0 flex-1 overflow-hidden", view === "terminals" ? "block" : "hidden")}>
            {visitedViews.has("terminals") && (
              currentProject ? (
                <TerminalListPanel projectId={currentProject.project_id} />
              ) : (
                <NoProjectPlaceholder onCreate={() => setNewProjectOpen(true)} />
              )
            )}
          </div>
          <div className={cn("min-h-0 flex-1 overflow-hidden", view === "files" ? "block" : "hidden")}>
            {visitedViews.has("files") && (
              currentProject ? (
                <FileBrowserPanel key={currentProject.project_id} projectId={currentProject.project_id} active={view === "files"} />
              ) : (
                <NoProjectPlaceholder onCreate={() => setNewProjectOpen(true)} />
              )
            )}
          </div>
          <div className={cn("min-h-0 flex-1 overflow-hidden", view === "members" ? "block" : "hidden")}>
            {visitedViews.has("members") && (
              currentProject ? (
                <ProjectMembersPanel
                  key={currentProject.project_id}
                  project={currentProject}
                  active={view === "members"}
                  canManage={currentProject.access_role === "owner"}
                />
              ) : (
                <NoProjectPlaceholder onCreate={() => setNewProjectOpen(true)} />
              )
            )}
          </div>
          <div className={cn("min-h-0 flex-1 overflow-hidden", view === "skills" ? "block" : "hidden")}>
            {visitedViews.has("skills") && <SkillBrowserPanel active={view === "skills"} />}
          </div>
          </div>
          </div>

        </aside>
        {children}
      </div>

      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
      />

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />

      <RenameProjectDialog
        project={renameProjectTarget}
        open={renameProjectTarget !== null}
        onOpenChange={open => { if (!open) setRenameProjectTarget(null) }}
      />

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
          await deleteSession(target.session_id)
          if (selectedSessionId === target.session_id) {
            router.push("/")
          }
        }}
      />

      <ConfirmDialog
        open={stopSandboxTarget !== null}
        onOpenChange={open => { if (!open) setStopSandboxTarget(null) }}
        title="Stop agent?"
        description={
          <>
            The agent for{" "}
            <span className="font-medium text-foreground">{stopSandboxTarget?.project_name ?? "Untitled"}</span>
            {" "}will stop running tasks and release loaded sessions. Files remain available,
            and conversations resume on the next message.
          </>
        }
        confirmLabel="Stop"
        destructive
        onConfirm={async () => {
          if (!stopSandboxTarget) return
          await stopSandbox(stopSandboxTarget.project_id)
        }}
      />

      <ConfirmDialog
        open={deleteProjectTarget !== null}
        onOpenChange={open => { if (!open) setDeleteProjectTarget(null) }}
        title="Delete project?"
        description={
          <>
            <span className="font-medium text-foreground">{deleteProjectTarget?.project_name ?? "Untitled"}</span>
            {" "}and all its sessions and shared files will be permanently deleted. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleteProjectTarget) return
          const target = deleteProjectTarget
          await deleteProject(target.project_id)
          if (selectedSessionId && target.sessions.some(s => s.session_id === selectedSessionId)) {
            router.push("/")
          }
        }}
      />
    </>
  )
}

function formatSessionTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function buildSessionNode({
  session,
  selected,
  busy,
  onRoute,
  onRequestDelete,
  onRequestRename,
}: {
  session: Session
  selected: boolean
  busy: boolean
  onRoute: (sessionId: string) => void
  onRequestDelete: (sess: Session) => void
  onRequestRename: (sess: Session) => void
}): TreeNode {
  return {
    id: `s-${session.session_id}`,
    expandable: false,
    selected,
    onClick: () => onRoute(session.session_id),
    body: (
      <>
        {busy || session.status === "creating" ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <MessageSquare
            className={cn("size-3.5 shrink-0", session.status === "failed" ? "text-destructive" : "text-muted-foreground")}
          />
        )}
        <span className="flex-1 truncate">{session.title ?? "New Session"}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground/70 group-hover/treerow:hidden">
          <span className="flex items-center" title={session.model}>
            <ModelIcon id={session.model} className="size-3" />
          </span>
          <span
            className="font-mono text-2xs font-normal tabular-nums"
            title={new Date(sessionActivityTime(session)).toLocaleString()}
          >
            {formatSessionTime(sessionActivityTime(session))}
          </span>
        </span>
      </>
    ),
    actions: (
      <>
        <TreeRowAction
          title="Rename session"
          aria-label="Rename session"
          onClick={e => { e.stopPropagation(); onRequestRename(session) }}
        >
          <Pencil className="size-3.5" />
        </TreeRowAction>
        <TreeRowAction
          destructive
          title="Delete session"
          aria-label="Delete session"
          onClick={e => { e.stopPropagation(); onRequestDelete(session) }}
        >
          <Trash2 className="size-3.5" />
        </TreeRowAction>
      </>
    ),
  }
}

function NoProjectPlaceholder({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <FolderOpen className="size-8 text-muted-foreground/50" />
      <p className="mt-2 text-xs text-muted-foreground">No project selected</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onCreate}>
        <Plus />
        Create project
      </Button>
    </div>
  )
}

// IDE-style run control for the current project's agent: play to start, stop while running.
function ProjectRunButton({
  project,
  starting: startRequested,
  onStart,
  onStop,
}: {
  project: ProjectWithSessions
  starting: boolean
  onStart: () => void
  onStop: () => void
}) {
  const starting = startRequested || project.sandbox_status === "starting"
  const running = project.sandbox_status === "ready"
  const failed = project.sandbox_status === "failed"
  const canStop = project.access_role === "owner"
  const label = starting ? "Agent starting" : running ? "Stop agent" : failed ? "Retry starting agent" : "Start agent"

  return (
    <button
      type="button"
      disabled={starting || (running && !canStop)}
      aria-label={label}
      title={running && !canStop ? "Only the project owner can stop the agent" : label}
      onClick={running ? onStop : onStart}
      className={cn(
        "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50",
        starting ? "text-muted-foreground" : running || failed ? "text-destructive hover:bg-destructive/10" : "text-emerald-500 hover:bg-emerald-500/10",
      )}
    >
      {starting
        ? <Loader2 className="size-3.5 animate-spin" />
        : running
          ? <Square className="size-3 fill-current" />
          : <Play className="size-3.5 fill-current" />}
      {starting ? "Starting" : running ? "Stop" : "Start"}
    </button>
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
          "pointer-events-none absolute left-0 inset-y-0 w-0.5 transition-colors",
          active ? "bg-primary" : "bg-transparent",
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

// RailButton — bottom-of-rail toggle (account/settings). Same footprint as
// ActivityButton but no view-active indicator bar; `active` just reflects
// whether its popover is open.
function RailButton({
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
  )
}
