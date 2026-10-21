"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Cat,
  Check,
  ChevronsUpDown,
  FolderOpen,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Play,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  Settings,
  Shield,
  Trash2,
  UserCircle2,
  Users,
} from "lucide-react"
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
import { ThemeToggle } from "@/components/theme-toggle"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { type Session } from "@/lib/api"
import { type ProjectWithSessions, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"
import { compareSessionActivity, sessionActivityTime } from "@/lib/session-activity"

type SidebarView = "sessions" | "files" | "members" | "skills"
const VIEW_STORAGE_KEY = "cattery:sidebar:view"
const MIN_REFRESH_SPIN_MS = 1000

function readSidebarView(): SidebarView {
  if (typeof window === "undefined") return "sessions"
  const saved = localStorage.getItem(VIEW_STORAGE_KEY)
  return saved === "files" || saved === "members" || saved === "sessions" || saved === "skills" ? saved : "sessions"
}

export function Sidebar() {
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
    function onPointerDown(e: PointerEvent) {
      if (projectPickerRef.current && !projectPickerRef.current.contains(e.target as Node)) {
        setProjectPickerOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
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
  const sandboxStatus = currentProject?.sandbox_status ?? "idle"

  // The sandbox starts on demand (first session / first message after a
  // stop). Poll the project while it's coming up so the header dot settles.
  const pollProjectId = currentProject && sandboxStatus === "starting" ? currentProject.project_id : null
  useEffect(() => {
    if (!pollProjectId) return
    const timer = setInterval(() => {
      void refreshProject(pollProjectId).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [pollProjectId, refreshProject])

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
            {projects.length === 0 ? (
              <button
                type="button"
                onClick={() => setNewProjectOpen(true)}
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                className={cn(
                  "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs transition-colors",
                  "hover:bg-muted",
                  projectPickerOpen && "bg-muted",
                )}
                title="Switch project"
              >
                <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-foreground">
                  {currentProject?.project_name ?? "Untitled"}
                  {currentProject && (
                    <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                      {currentProject.project_id}
                    </span>
                  )}
                </span>
                <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            )}
            {projectPickerOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-[400px] max-h-[60vh] overflow-y-auto rounded-md border bg-popover text-sm shadow-md">
                {projects.map(project => {
                  const active = project.project_id === currentProjectId
                  const ownsProject = project.access_role === "owner"
                  return (
                    <div
                      key={project.project_id}
                      className={cn(
                        "group/proj flex min-h-9 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted",
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
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs">
                          {project.project_name ?? "Untitled"}
                        </span>
                        <span className="whitespace-nowrap font-mono text-[10px] leading-tight text-muted-foreground">
                          {project.project_id}
                        </span>
                      </span>
                      {!ownsProject && (
                        <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">
                          {project.access_role}
                        </Badge>
                      )}
                      {ownsProject && (
                        <>
                          <button
                            type="button"
                            title="Rename project"
                            aria-label="Rename project"
                            onClick={e => {
                              e.stopPropagation()
                              setProjectPickerOpen(false)
                              setRenameProjectTarget(project)
                            }}
                            className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            title="Delete project"
                            aria-label="Delete project"
                            onClick={e => {
                              e.stopPropagation()
                              setProjectPickerOpen(false)
                              setDeleteProjectTarget(project)
                            }}
                            className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
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
                  Create project
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex w-12 shrink-0 flex-col gap-1 border-r">
          <ActivityButton
            icon={<MessagesSquare className="size-5" />}
            label="Sessions"
            active={view === "sessions"}
            onClick={() => switchView("sessions")}
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
            <div ref={userMenuRef} className="relative">
              {userMenuOpen && (
                <div className="absolute bottom-0 left-full z-30 ml-1 min-w-44 overflow-hidden rounded-md border bg-popover text-sm shadow-md">
                  <div className="border-b px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{user?.username ?? "-"}</span>
                      {user?.is_admin && (
                        <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">admin</Badge>
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
              <RailButton
                icon={<UserCircle2 className="size-5" />}
                label="Account"
                active={userMenuOpen}
                onClick={() => { setUserMenuOpen(o => !o); setSettingsMenuOpen(false) }}
              />
            </div>

            <div ref={settingsMenuRef} className="relative">
              {settingsMenuOpen && (
                <div className="absolute bottom-0 left-full z-30 ml-1 min-w-44 overflow-hidden rounded-md border bg-popover text-sm shadow-md">
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
        <div className={cn("min-w-0 flex-1 flex-col", view === "sessions" ? "flex" : "hidden")}>
        {currentProject && (
          <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Sessions
              <span
                title={`sandbox: ${sandboxStatus}`}
                className={cn("size-1.5 shrink-0 rounded-full", sandboxDot(sandboxStatus))}
              />
            </span>
            <div className="flex items-center gap-1">
              {(sandboxStatus === "idle" || sandboxStatus === "failed") && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    startSandbox(currentProject.project_id).catch(err =>
                      window.alert(err instanceof Error ? err.message : "Failed to start sandbox"),
                    )
                  }}
                  title={sandboxStatus === "failed" ? "Retry starting sandbox" : "Start sandbox"}
                >
                  <Play />
                </Button>
              )}
              {currentProject.access_role === "owner" && (sandboxStatus === "ready" || sandboxStatus === "starting") && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setStopSandboxTarget(currentProject)}
                  title="Stop sandbox"
                >
                  <Power />
                </Button>
              )}
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

      </aside>

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
        title="Stop sandbox?"
        description={
          <>
            The agent sandbox for{" "}
            <span className="font-medium text-foreground">{stopSandboxTarget?.project_name ?? "Untitled"}</span>
            {" "}will be stopped and any running turn aborted. Sessions and files are kept; the sandbox
            starts again on the next message.
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

function sandboxDot(status: string): string {
  if (status === "ready") return "bg-emerald-500"
  if (status === "failed") return "bg-destructive"
  if (status === "starting") return "bg-amber-400 animate-pulse"
  return "bg-muted-foreground/40"
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
            className="font-mono text-[10px] font-normal tabular-nums"
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
