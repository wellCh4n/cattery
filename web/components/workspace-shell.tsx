"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  ChartColumn,
  Check,
  ChevronDown,
  FolderOpen,
  GitFork,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  MessagesSquare,
  Pencil,
  Plus,
  Puzzle,
  Settings,
  Shield,
  SquareTerminal,
  Trash2,
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
import { AppListPanel } from "@/components/app-list-panel"
import { AppWatcher } from "@/components/app-watcher"
import { ProjectMembersPanel } from "@/components/project-members-panel"
import { RenameProjectDialog } from "@/components/rename-project-dialog"
import { RenameSessionDialog } from "@/components/rename-session-dialog"
import { SkillBrowserPanel } from "@/components/skill-browser-panel"
import { TerminalListPanel } from "@/components/terminal-list-panel"
import { ThemeToggle } from "@/components/theme-toggle"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { WorkspaceItemBody } from "@/components/workspace-item-body"
import { UserAvatar } from "@/components/user-avatar"
import { Hint } from "@/components/ui/hint"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { type Session } from "@/lib/api"
import { canWriteSession, type ProjectWithSessions, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"
import { useForkSession } from "@/lib/use-fork-session"
import { compareSessionActivity, sessionActivityTime } from "@/lib/session-activity"
import { RefreshButton } from "@/components/refresh-button"

type SidebarView = "sessions" | "terminals" | "apps" | "files" | "members" | "skills"
const VIEW_STORAGE_KEY = "cattery:sidebar:view"

function readSidebarView(): SidebarView {
  if (typeof window === "undefined") return "sessions"
  const saved = localStorage.getItem(VIEW_STORAGE_KEY)
  return saved === "files" || saved === "members" || saved === "sessions" || saved === "skills" || saved === "terminals" || saved === "apps" ? saved : "sessions"
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
  const createSession = useWorkspaceStore(state => state.createSession)
  const { fork: forkSession } = useForkSession()
  const deleteSession = useWorkspaceStore(state => state.deleteSession)
  const deleteProject = useWorkspaceStore(state => state.deleteProject)

  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ session_id: string; title: string } | null>(null)
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
    // Like the other views, which reload when shown. The first load happens
    // with the workspace, so only switching back refreshes.
    if (next === "sessions" && view !== "sessions") void refreshSessions()
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
    try {
      await loadProjects()
    } finally {
      setRefreshingSessions(false)
    }
  }

  return (
    <>
      {currentProject && <AppWatcher key={currentProject.project_id} projectId={currentProject.project_id} />}
      <header className="flex h-12 shrink-0 items-center gap-2 px-3.5">
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
            <div className="absolute left-0 top-full z-30 mt-1 flex w-72 max-w-[calc(100vw-2rem)] max-h-[60vh] flex-col gap-1 overflow-y-auto rounded-lg border bg-popover p-1 text-sm shadow-md">
              {projects.map(project => {
                const active = project.project_id === currentProjectId
                const ownsProject = project.access_role === "owner"
                return (
                  <div key={project.project_id}>
                    <div className={cn("flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-accent focus-within:bg-accent", active && "bg-accent")}>
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
              <button
                type="button"
                className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-accent"
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
              "flex cursor-pointer rounded-full ring-offset-2 ring-offset-background transition-shadow outline-none hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring/50",
              userMenuOpen && "ring-2 ring-primary/40 hover:ring-primary/40",
            )}
          >
            <UserAvatar username={user?.username} className="size-8 text-xs" />
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
          <div className="flex w-13 shrink-0 flex-col gap-1">
            <ActivityButton
              icon={<MessagesSquare className="size-6" />}
              label="Sessions"
              active={view === "sessions"}
              onClick={() => switchView("sessions")}
            />
            <ActivityButton
              icon={<FolderOpen className="size-6" />}
              label="Files"
              active={view === "files"}
              onClick={() => switchView("files")}
            />
            <ActivityButton
              icon={<Globe className="size-6" />}
              label="Apps"
              active={view === "apps"}
              onClick={() => switchView("apps")}
            />
            <ActivityButton
              icon={<SquareTerminal className="size-6" />}
              label="Terminals"
              active={view === "terminals"}
              onClick={() => switchView("terminals")}
            />
            <ActivityButton
              icon={<Puzzle className="size-6" />}
              label="Skills"
              active={view === "skills"}
              onClick={() => switchView("skills")}
            />
            <ActivityButton
              icon={<Users className="size-6" />}
              label="Members"
              active={view === "members"}
              onClick={() => switchView("members")}
            />

            <div className="mt-auto flex flex-col gap-1">
              <RailButton
                icon={<ChartColumn className="size-6" />}
                label="Usage"
                active={pathname === "/usage"}
                onClick={() => { router.push("/usage"); setSettingsMenuOpen(false) }}
              />
              <div ref={settingsMenuRef} className="relative">
                {settingsMenuOpen && (
                  <div className="absolute bottom-0 left-full z-30 ml-1 min-w-44 overflow-hidden whitespace-nowrap rounded-lg border bg-popover text-sm shadow-md">
                    {user?.is_admin && (
                      <button
                        className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                        onClick={() => { setSettingsMenuOpen(false); router.push("/admin/users") }}
                      >
                        <Shield className="size-3.5 text-muted-foreground" />
                        User management
                      </button>
                    )}
                    {user?.is_admin && (
                      <button
                        className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                        onClick={() => { setSettingsMenuOpen(false); router.push("/admin/usage") }}
                      >
                        <ChartColumn className="size-3.5 text-muted-foreground" />
                        Team usage
                      </button>
                    )}
                    {user?.is_admin && (
                      <button
                        className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-muted"
                        onClick={() => { setSettingsMenuOpen(false); router.push("/admin/skills") }}
                      >
                        <Puzzle className="size-3.5 text-muted-foreground" />
                        Skill management
                      </button>
                    )}
                    <div className="flex h-8 items-center justify-between gap-2 px-2.5">
                      <span className="text-muted-foreground">Theme</span>
                      <ThemeToggle />
                    </div>
                  </div>
                )}
                <RailButton
                  icon={<Settings className="size-6" />}
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
            <div className="flex h-9 shrink-0 items-center justify-between px-2">
              <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Sessions
              </span>
              <div className="flex items-center gap-1">
                <RefreshButton onClick={refreshSessions} refreshing={refreshingSessions} aria-label="Refresh sessions" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCreateSession}
                  disabled={creatingSession}
                  aria-label="New session"
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
                writable: !!currentProject && canWriteSession(sess, currentProject, user?.user_id),
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
                onRequestFork: s => void forkSession(s.session_id),
              }))}
            />
          </div>
          </div>
          <div className={cn("min-h-0 flex-1 overflow-hidden", view === "terminals" ? "block" : "hidden")}>
            {visitedViews.has("terminals") && (
              currentProject ? (
                <TerminalListPanel projectId={currentProject.project_id} active={view === "terminals"} />
              ) : (
                <NoProjectPlaceholder onCreate={() => setNewProjectOpen(true)} />
              )
            )}
          </div>
          <div className={cn("min-h-0 flex-1 overflow-hidden", view === "apps" ? "block" : "hidden")}>
            {visitedViews.has("apps") && (
              currentProject ? (
                <AppListPanel key={currentProject.project_id} projectId={currentProject.project_id} />
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
            {visitedViews.has("skills") && (
              currentProject ? (
                <SkillBrowserPanel key={currentProject.project_id} projectId={currentProject.project_id} active={view === "skills"} />
              ) : (
                <NoProjectPlaceholder onCreate={() => setNewProjectOpen(true)} />
              )
            )}
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

function buildSessionNode({
  session,
  selected,
  writable,
  busy,
  onRoute,
  onRequestDelete,
  onRequestRename,
  onRequestFork,
}: {
  session: Session
  selected: boolean
  writable: boolean
  busy: boolean
  onRoute: (sessionId: string) => void
  onRequestDelete: (sess: Session) => void
  onRequestRename: (sess: Session) => void
  onRequestFork: (sess: Session) => void
}): TreeNode {
  return {
    id: `s-${session.session_id}`,
    expandable: false,
    selected,
    rowClassName: "h-14 items-start py-1.5",
    onClick: () => onRoute(session.session_id),
    body: (
      <WorkspaceItemBody
        icon={busy || session.status === "creating" ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <MessageSquare className={cn("size-4", session.status === "failed" ? "text-destructive" : "text-muted-foreground")} />
        )}
        title={session.title ?? "New Session"}
        creator={session.created_by_username}
        timestamp={sessionActivityTime(session)}
        accessory={
          <span className="flex shrink-0 items-center text-muted-foreground/70">
            <ModelIcon id={session.model} className="size-3.5" />
          </span>
        }
        actions={
          <>
            {writable && (
              <TreeRowAction aria-label="Rename session" onClick={e => { e.stopPropagation(); onRequestRename(session) }}>
                <Pencil className="size-4" />
              </TreeRowAction>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                // Stays visible while its menu is open, after the pointer leaves the row.
                render={<TreeRowAction aria-label="More actions" className="data-popup-open:inline-flex data-popup-open:bg-foreground/10" onClick={e => e.stopPropagation()} />}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              {/* Portaled, but React events still bubble to the row and would open the session. */}
              {/* Drops below the button and extends right, over the main pane. */}
              <DropdownMenuContent side="bottom" align="start" className="w-40" onClick={e => e.stopPropagation()}>
                {/* Any member can fork; the copy is theirs. */}
                <DropdownMenuItem className="cursor-pointer" disabled={session.status !== "ready" || busy} onClick={() => onRequestFork(session)}>
                  <GitFork />
                  Fork
                </DropdownMenuItem>
                {writable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="cursor-pointer" variant="destructive" onClick={() => onRequestDelete(session)}>
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
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
    <div className="flex justify-center">
      <Hint label={label} side="right">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "flex size-10 cursor-pointer items-center justify-center rounded-md transition-colors",
          active
            ? "bg-muted-foreground/15 text-foreground dark:bg-foreground/20"
            : "text-muted-foreground hover:bg-muted-foreground/8 hover:text-foreground dark:hover:bg-foreground/8",
        )}
      >
        {icon}
      </button>
      </Hint>
    </div>
  )
}

// RailButton — bottom-of-rail toggle (account/settings). Same footprint as
// ActivityButton but no selected background; `active` just reflects whether
// its popover is open.
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
    <Hint label={label} side="right">
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-11 w-full cursor-pointer items-center justify-center transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
    </button>
    </Hint>
  )
}
