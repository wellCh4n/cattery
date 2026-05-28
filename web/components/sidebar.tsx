"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Bot,
  Cat,
  Check,
  ChevronsUpDown,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Terminal,
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
import { RenameProjectDialog } from "@/components/rename-project-dialog"
import { RenameSessionDialog } from "@/components/rename-session-dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { type Session } from "@/lib/api"
import { type HarnessWithSessions, type ProjectWithHarnesses, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"

type SidebarView = "harnesses" | "files" | "members"
const VIEW_STORAGE_KEY = "cattery:sidebar:view"
const MIN_REFRESH_SPIN_MS = 1000

function readSidebarView(): SidebarView {
  if (typeof window === "undefined") return "harnesses"
  const saved = localStorage.getItem(VIEW_STORAGE_KEY)
  return saved === "files" || saved === "members" || saved === "harnesses" ? saved : "harnesses"
}

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
  const [autoOpenHarness, setAutoOpenHarness] = useState<string | null>(null)
  const autoOpenedRef = useRef<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [createHarnessProject, setCreateHarnessProject] = useState<ProjectWithHarnesses | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ session_id: string; harness_id: string; title: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<Session | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectWithHarnesses | null>(null)
  const [renameProjectTarget, setRenameProjectTarget] = useState<ProjectWithHarnesses | null>(null)
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
  const [refreshingHarnesses, setRefreshingHarnesses] = useState(false)
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

  const handleNewSession = useCallback(async (harness: HarnessWithSessions) => {
    if (!canCreateSession(harness)) return
    setLaunching(harness.harness_id)
    try {
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
      const session = await createSession(harness, theme)
      router.push(`/sessions/${session.session_id}`)
    } finally {
      setLaunching(null)
    }
  }, [createSession, router])

  // A freshly created harness has a sandbox that is still starting, so a session
  // can't be created yet. Wait for the sandbox to reach a terminal state via
  // polling: once ready, auto-create the first session and open it; if it fails,
  // just stop. The ref guarantees we act at most once per harness.
  useEffect(() => {
    if (!autoOpenHarness || autoOpenedRef.current === autoOpenHarness) return
    const harness = projects.flatMap(p => p.harnesses).find(h => h.harness_id === autoOpenHarness)
    if (!harness) return
    if (harness.sandbox_status !== "ready" && harness.sandbox_status !== "failed") return
    autoOpenedRef.current = autoOpenHarness
    if (harness.sandbox_status === "ready") queueMicrotask(() => void handleNewSession(harness))
  }, [autoOpenHarness, projects, handleNewSession])

  async function refreshHarnesses() {
    setRefreshingHarnesses(true)
    const startedAt = Date.now()
    try {
      await loadProjects()
    } finally {
      const remaining = MIN_REFRESH_SPIN_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      setRefreshingHarnesses(false)
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
                </span>
                <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            )}
            {projectPickerOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-[320px] max-h-[60vh] overflow-y-auto rounded-md border bg-popover text-sm shadow-md">
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
                            className="hidden size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground group-hover/proj:inline-flex"
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
                            className="hidden size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive group-hover/proj:inline-flex"
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
        <div className="flex w-12 shrink-0 flex-col gap-1 border-r py-2">
          <ActivityButton
            icon={<Bot className="size-5" />}
            label="Harnesses"
            active={view === "harnesses"}
            onClick={() => switchView("harnesses")}
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
        <div className={cn("min-w-0 flex-1 flex-col", view === "harnesses" ? "flex" : "hidden")}>
        {currentProject && (
          <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Harnesses
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={refreshHarnesses}
                disabled={refreshingHarnesses}
                title="Refresh harnesses"
              >
                <RefreshCw className={refreshingHarnesses ? "animate-spin" : undefined} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setCreateHarnessProject(currentProject)}
                title="New harness"
              >
                <Plus />
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

          {currentProject && harnesses.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center px-4 text-center">
              <Bot className="size-8 text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">No harnesses</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setCreateHarnessProject(currentProject)}
              >
                <Plus />
                New harness
              </Button>
            </div>
          )}

          <Tree
            items={harnesses.map(harness => buildHarnessNode({
              harness,
              selectedHarnessId,
              selectedSessionId,
              launching,
              busySessions,
              onToggleExpand: toggleHarnessExpand,
              onNewSession: handleNewSession,
              onRouteSession: id => router.push(`/sessions/${id}`),
              onRouteHarness: id => router.push(`/harnesses/${id}`),
              onRequestDeleteSession: (sess, harnessId) => setDeleteSessionTarget({
                session_id: sess.session_id,
                harness_id: harnessId,
                title: sess.title ?? "New Session",
              }),
              onRequestRenameSession: sess => {
                setRenameTarget(sess)
                setRenameOpen(true)
              },
            }))}
          />
        </div>
        </div>
        <div className={cn("min-h-0 flex-1 overflow-hidden", view === "files" ? "block" : "hidden")}>
          {visitedViews.has("files") && (
            currentProject ? (
              <FileBrowserPanel key={currentProject.project_id} projectId={currentProject.project_id} />
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
                canManage={currentProject.access_role === "owner"}
              />
            ) : (
              <NoProjectPlaceholder onCreate={() => setNewProjectOpen(true)} />
            )
          )}
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
            setAutoOpenHarness(harness.harness_id)
          }}
        />
      )}

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

function sandboxDot(status: string): string | null {
  if (status === "ready") return null
  if (status === "failed") return "bg-destructive"
  if (status === "starting") return "bg-amber-400 animate-pulse"
  return "bg-muted-foreground/40"
}

function canCreateSession(harness: HarnessWithSessions): boolean {
  return harness.sandbox_status === "ready"
}

function newSessionTitle(harness: HarnessWithSessions): string {
  return canCreateSession(harness) ? "New session" : "Sandbox is not ready"
}

function buildHarnessNode({
  harness,
  selectedHarnessId,
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
  selectedHarnessId: string | null
  selectedSessionId: string | null
  launching: string | null
  busySessions: Set<string>
  onToggleExpand: (harnessId: string) => void
  onNewSession: (harness: HarnessWithSessions) => void
  onRouteSession: (sessionId: string) => void
  onRouteHarness: (harnessId: string) => void
  onRequestDeleteSession: (sess: Session, harnessId: string) => void
  onRequestRenameSession: (sess: Session) => void
}): TreeNode {
  // Leading glyph signals transport kind only (chat vs terminal); its color
  // stays muted like every other tree icon. Activity is shown by swapping in a
  // spinner while busy (see below), not by recoloring the icon.
  const SessionIcon = harness.transport_kind === "terminal" ? Terminal : MessageSquare
  const sessions: TreeNode[] = harness.sessions.map(sess => ({
    id: `s-${sess.session_id}`,
    expandable: false,
    selected: selectedSessionId === sess.session_id,
    onClick: () => onRouteSession(sess.session_id),
    body: (
      <>
        {busySessions.has(sess.session_id) ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <SessionIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate">{sess.title ?? "New Session"}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70 group-hover/treerow:hidden">
          {new Date(sess.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
      </>
    ),
    actions: (
      <>
        <TreeRowAction
          title="Rename session"
          aria-label="Rename session"
          onClick={e => { e.stopPropagation(); onRequestRenameSession(sess) }}
        >
          <Pencil className="size-3.5" />
        </TreeRowAction>
        <TreeRowAction
          destructive
          title="Delete session"
          aria-label="Delete session"
          onClick={e => { e.stopPropagation(); onRequestDeleteSession(sess, harness.harness_id) }}
        >
          <Trash2 className="size-3.5" />
        </TreeRowAction>
      </>
    ),
  }))

  return {
    id: `h-${harness.harness_id}`,
    expandable: true,
    expanded: harness.expanded,
    children: sessions,
    selected: selectedHarnessId === harness.harness_id,
    onClick: () => onToggleExpand(harness.harness_id),
    body: (
      <>
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
          className="h-4 shrink-0 px-1.5 text-[10px] font-normal group-hover/treerow:hidden"
        >
          {harness.access_role === "owner" ? TYPE_LABELS[harness.type] ?? harness.type : harness.access_role}
        </Badge>
      </>
    ),
    actions: (
      <>
        <TreeRowAction
          className={cn(
            !canCreateSession(harness) && "cursor-not-allowed text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/40",
          )}
          title={newSessionTitle(harness)}
          disabled={launching === harness.harness_id || !canCreateSession(harness)}
          onClick={e => { e.stopPropagation(); onNewSession(harness) }}
        >
          {launching === harness.harness_id
            ? <Loader2 className="size-3.5 animate-spin" />
            : <Plus className="size-3.5" />}
        </TreeRowAction>
        <TreeRowAction
          title="Harness info"
          onClick={e => { e.stopPropagation(); onRouteHarness(harness.harness_id) }}
        >
          <Info className="size-3.5" />
        </TreeRowAction>
      </>
    ),
    subline: harness.access_role !== "owner" ? (
      <div className="ml-8 truncate text-[10px] text-muted-foreground/70">
        {harness.owner_username} · {harness.access_role}
      </div>
    ) : undefined,
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
