"use client"

import { useEffect, useState, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Bot,
  ChevronRight,
  Plus,
  Trash2,
  Loader2,
  Cat,
  MessagesSquare,
  Pencil,
  Share2,
  Check,
  KeyRound,
  LogOut,
  Shield,
  UserCircle2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { CreateHarnessDialog } from "@/components/create-harness-dialog"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { ShareHarnessDialog } from "@/components/share-harness-dialog"
import { HarnessIcon } from "@/components/harness-icon"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { type Harness, type Session } from "@/lib/api"
import { type HarnessWithSessions, useWorkspaceStore } from "@/lib/workspace-store"
import { useAuthStore } from "@/lib/auth-store"

type DeleteTarget =
  | { kind: "harness"; id: string; name: string }
  | { kind: "session"; id: string; harnessId: string }

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
  const renameHarness = useWorkspaceStore(state => state.renameHarness)
  const renameSession = useWorkspaceStore(state => state.renameSession)
  const addHarness = useWorkspaceStore(state => state.addHarness)
  const createSession = useWorkspaceStore(state => state.createSession)
  const deleteHarness = useWorkspaceStore(state => state.deleteHarness)
  const deleteSession = useWorkspaceStore(state => state.deleteSession)
  const [launching, setLaunching] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [shareTarget, setShareTarget] = useState<Harness | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState<{ kind: "harness"; id: string; original: string } | { kind: "session"; id: string; original: string } | null>(null)
  const [editValue, setEditValue] = useState("")
  const editInputRef = useRef<HTMLInputElement>(null)
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Click-outside closes the user menu. Pointerdown beats click on touch
  // and avoids losing the menu before nested Dialog triggers fire.
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
  // sidebar resize — same UX as RightRail, handle on the right edge
  const { width: sidebarWidth, onMouseDown: onSidebarMouseDown } = useResizable({
    initial: 256, // matches the old `w-64`
    min: 200,
    max: 480,
    storageKey: "cattery:sidebar:width",
    side: "right",
  })

  function startEdit(kind: "harness" | "session", id: string, current: string) {
    setEditing({ kind, id, original: current } as { kind: "harness"; id: string; original: string } | { kind: "session"; id: string; original: string })
    setEditValue(current)
    setTimeout(() => editInputRef.current?.focus(), 0)
  }

  async function commitEdit() {
    if (!editing) return
    const val = editValue.trim()
    if (val === editing.original.trim()) {
      setEditing(null)
      return
    }
    try {
      if (editing.kind === "harness") {
        await renameHarness(editing.id, val)
      } else {
        await renameSession(editing.id, val)
      }
    } catch { /* ignore */ }
    setEditing(null)
  }

  function cancelEdit() {
    setEditing(null)
  }

  function handleEditBlur(related: EventTarget | null) {
    // blur 触发时点击保存按钮的话，让按钮的 onClick 走 commitEdit；
    // 其他点击（含点到 sidebar 外、列表其它项）一律取消编辑。
    if (related instanceof HTMLElement && related.closest("[data-edit-save]")) {
      return
    }
    cancelEdit()
  }

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
      // 把当前页面主题透给 codex —— 它只在启动时探一次 OSC 10/11，
      // 之后用户在浏览器里切主题，codex 那边不会同步变。
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
      const session = await createSession(harness, theme)
      router.push(`/sessions/${session.session_id}`)
    } finally {
      setLaunching(null)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.kind === "harness") {
        const removed = await deleteHarness(deleteTarget.id)
        if (removed?.sessions.some(s => s.session_id === selectedSessionId)) {
          router.push("/")
        }
      } else {
        await deleteSession(deleteTarget.id, deleteTarget.harnessId)
        if (selectedSessionId === deleteTarget.id) {
          router.push("/")
        }
      }
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  function statusDot(status: string) {
    if (status === "ready") return "bg-emerald-500"
    if (status === "failed") return "bg-destructive"
    return "bg-amber-400 animate-pulse"
  }

  // sandbox 状态点：idle 灰、starting 黄脉冲、ready 绿、failed 红。
  // ready 时不显示，避免成功后的视觉噪音。
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

  // harness type 在创建对话框里有大小写规范的 label（OpenCode / Claude Code / Codex / Hermes），
  // 这里复用同一份映射，避免侧栏显示成全小写的 `opencode` / `claude-code`。
  const TYPE_LABELS: Record<string, string> = {
    "opencode":    "OpenCode",
    "claude-code": "Claude Code",
    "codex":       "Codex",
    "hermes":      "Hermes",
  }

  // 最近沟通的 session：按 last_seen_at（fallback created_at）倒序，取前 3
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
        className="relative flex flex-col h-full border-r bg-sidebar shrink-0"
        style={{ width: sidebarWidth }}
      >
        {/* drag handle on the right edge — same UX as RightRail */}
        <div
          onMouseDown={onSidebarMouseDown}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors translate-x-1/2 z-10"
        />
        <header className="flex items-center justify-between px-3 h-12 border-b shrink-0">
          <div className="flex items-center gap-1.5">
            <Cat className="size-4 text-foreground" />
            <span className="font-heading font-semibold text-sm tracking-tight">Cattery</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <CreateHarnessDialog
              onCreated={addHarness}
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-1.5">
          {recentSessions.length > 0 && (
            <div className="px-1.5 mb-2">
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
                      "group/recent w-full flex items-center gap-2 text-xs px-2 h-7 rounded-md transition-colors cursor-pointer",
                      "hover:bg-muted text-muted-foreground hover:text-foreground",
                      selectedSessionId === sess.session_id &&
                        "bg-muted text-foreground font-medium"
                    )}
                  >
                    {busySessions.has(sess.session_id) ? (
                      <Loader2 className="size-3 text-amber-500 animate-spin shrink-0" />
                    ) : (
                      <span className={cn("size-1.5 rounded-full shrink-0", statusDot(sess.status))} />
                    )}
                    <span className="truncate flex-1 text-left">
                      {sess.title ?? "New Session"}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0 truncate max-w-[60px]">
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
              <Bot className="size-8 mx-auto text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground mt-2">No harnesses yet</p>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                Create one to get started
              </p>
            </div>
          )}
          <HarnessListSection
            title={sharedHarnesses.length > 0 ? "My Harnesses" : null}
            harnesses={ownHarnesses}
            selectedSessionId={selectedSessionId}
            selectedHarnessId={selectedHarnessId}
            launching={launching}
            busySessions={busySessions}
            editing={editing}
            editValue={editValue}
            editInputRef={editInputRef}
            typeLabels={TYPE_LABELS}
            onToggleExpand={toggleExpand}
            onNewSession={handleNewSession}
            onStartEdit={startEdit}
            onSetDeleteTarget={setDeleteTarget}
            onSetShareTarget={setShareTarget}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
            onHandleEditBlur={handleEditBlur}
            onSetEditValue={setEditValue}
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
            editing={editing}
            editValue={editValue}
            editInputRef={editInputRef}
            typeLabels={TYPE_LABELS}
            onToggleExpand={toggleExpand}
            onNewSession={handleNewSession}
            onStartEdit={startEdit}
            onSetDeleteTarget={setDeleteTarget}
            onSetShareTarget={setShareTarget}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
            onHandleEditBlur={handleEditBlur}
            onSetEditValue={setEditValue}
            onRouteSession={id => router.push(`/sessions/${id}`)}
            onRouteHarness={id => router.push(`/harnesses/${id}`)}
            canCreateSession={canCreateSession}
            newSessionTitle={newSessionTitle}
            statusDot={statusDot}
            sandboxDot={sandboxDot}
          />
        </div>

        {/* User menu — fixed at sidebar bottom. Click email to open the
            mini-menu above; click outside closes (see effect above). */}
        <div ref={userMenuRef} className="relative border-t shrink-0">
          {userMenuOpen && (
            <div className="absolute bottom-full left-1.5 right-1.5 mb-1 rounded-md border bg-popover shadow-md text-sm overflow-hidden">
              <button
                className="flex w-full items-center gap-2 px-2.5 h-8 text-left hover:bg-muted cursor-pointer"
                onClick={() => { setUserMenuOpen(false); setChangePasswordOpen(true) }}
              >
                <KeyRound className="size-3.5 text-muted-foreground" />
                Change password
              </button>
              {user?.is_admin && (
                <button
                  className="flex w-full items-center gap-2 px-2.5 h-8 text-left hover:bg-muted cursor-pointer"
                  onClick={() => { setUserMenuOpen(false); router.push("/admin/users") }}
                >
                  <Shield className="size-3.5 text-muted-foreground" />
                  User management
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 px-2.5 h-8 text-left hover:bg-muted text-destructive cursor-pointer"
                onClick={() => { setUserMenuOpen(false); logout() }}
              >
                <LogOut className="size-3.5" />
                Sign out
              </button>
            </div>
          )}
          <button
            className={cn(
              "flex w-full items-center gap-2 px-2.5 h-10 hover:bg-muted transition-colors cursor-pointer",
              userMenuOpen && "bg-muted"
            )}
            onClick={() => setUserMenuOpen(o => !o)}
          >
            <UserCircle2 className="size-4 text-muted-foreground shrink-0" />
            <span className="truncate text-xs text-foreground/90 flex-1 text-left">
              {user?.username ?? "—"}
            </span>
            {user?.is_admin && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-normal shrink-0">
                admin
              </Badge>
            )}
          </button>
        </div>
      </aside>

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
      <ShareHarnessDialog
        harness={shareTarget}
        open={shareTarget !== null}
        onOpenChange={open => { if (!open) setShareTarget(null) }}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.kind === "harness" ? "Delete harness" : "Delete session"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.kind === "harness"
                ? <>Delete <strong>{deleteTarget.name}</strong> and all its sessions? This will also stop the sandbox.</>
                : "Delete this session? Conversation history will be lost."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  editing,
  editValue,
  editInputRef,
  typeLabels,
  onToggleExpand,
  onNewSession,
  onStartEdit,
  onSetDeleteTarget,
  onSetShareTarget,
  onCommitEdit,
  onCancelEdit,
  onHandleEditBlur,
  onSetEditValue,
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
  editing: { kind: "harness"; id: string; original: string } | { kind: "session"; id: string; original: string } | null
  editValue: string
  editInputRef: React.RefObject<HTMLInputElement | null>
  typeLabels: Record<string, string>
  onToggleExpand: (harnessId: string) => void
  onNewSession: (harness: HarnessWithSessions) => void
  onStartEdit: (kind: "harness" | "session", id: string, current: string) => void
  onSetDeleteTarget: (target: DeleteTarget) => void
  onSetShareTarget: (harness: Harness) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onHandleEditBlur: (related: EventTarget | null) => void
  onSetEditValue: (value: string) => void
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
        <div key={harness.harness_id} className="px-1.5 mb-1">
          <div className={cn(
            "group flex items-center gap-0.5 rounded-md pl-1 pr-0.5 h-8 transition-colors",
            selectedHarnessId === harness.harness_id
              ? "bg-muted text-foreground"
              : "hover:bg-muted"
          )}>
            <button
              className="flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:text-foreground outline-none"
              onClick={() => onToggleExpand(harness.harness_id)}
              title={harness.expanded ? "Collapse" : "Expand"}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform shrink-0",
                  harness.expanded && "rotate-90"
                )}
              />
            </button>
            <button
              className="flex-1 flex cursor-pointer items-center gap-1.5 min-w-0 h-full text-left text-sm font-medium outline-none"
              onClick={() => onRouteHarness(harness.harness_id)}
            >
              {sandboxDot(harness.sandbox_status) && (
                <span
                  title={`sandbox: ${harness.sandbox_status}`}
                  className={cn("size-1.5 rounded-full shrink-0", sandboxDot(harness.sandbox_status))}
                />
              )}
              <HarnessIcon id={harness.type} className="size-3.5 text-muted-foreground shrink-0" />
              {editing?.kind === "harness" && editing.id === harness.harness_id ? (
                <Input
                  ref={editInputRef}
                  className="flex-1 h-6 pl-2 pr-2 py-0 text-sm font-medium min-w-0"
                  value={editValue}
                  onChange={e => onSetEditValue(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") onCommitEdit(); if (e.key === "Escape") onCancelEdit() }}
                  onBlur={e => onHandleEditBlur(e.relatedTarget)}
                  onClick={e => e.stopPropagation()}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              ) : (
                <>
                  <span className="truncate min-w-0 flex-1">
                    {harness.harness_name ?? "Untitled"}
                  </span>
                  <Badge
                    variant="secondary"
                    className="text-[10px] h-4 px-1.5 font-normal shrink-0 group-hover:hidden"
                  >
                    {harness.access_role === "owner" ? typeLabels[harness.type] ?? harness.type : harness.access_role}
                  </Badge>
                </>
              )}
            </button>
            <button
              className={cn(
                "hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center size-6 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                "disabled:text-muted-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
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
            {harness.access_role === "owner" && (
              <>
                {editing?.kind === "harness" && editing.id === harness.harness_id ? (
                  <button
                    data-edit-save
                    className="inline-flex cursor-pointer items-center justify-center size-6 rounded text-primary hover:bg-primary/10 transition-colors"
                    title="Save"
                    onClick={onCommitEdit}
                  >
                    <Check className="size-3.5" />
                  </button>
                ) : (
                  <button
                    className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                    title="Rename"
                    onClick={() => onStartEdit("harness", harness.harness_id, harness.harness_name ?? "")}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
                <button
                  className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                  title="Share"
                  onClick={() => onSetShareTarget(harness)}
                >
                  <Share2 className="size-3.5" />
                </button>
                <button
                  className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Delete harness"
                  onClick={() => onSetDeleteTarget({ kind: "harness", id: harness.harness_id, name: harness.harness_name ?? "Untitled" })}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </>
            )}
          </div>

          {harness.access_role !== "owner" && (
            <div className="ml-8 -mt-0.5 mb-1 truncate text-[10px] text-muted-foreground/70">
              {harness.owner_username} · {harness.access_role}
            </div>
          )}

          {harness.expanded && (
            <div className="ml-3.5 mt-1 border-l border-border/60 pl-1.5 space-y-0.5">
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
                      "group/sess w-full flex items-center gap-2 text-xs px-2 h-7 rounded-md transition-colors cursor-pointer",
                      "hover:bg-muted text-muted-foreground hover:text-foreground",
                      selectedSessionId === sess.session_id &&
                        "bg-muted text-foreground font-medium"
                    )}
                    onClick={() => onRouteSession(sess.session_id)}
                  >
                    {busySessions.has(sess.session_id) ? (
                      <Loader2 className="size-3 text-amber-500 animate-spin shrink-0" />
                    ) : (
                      <span className={cn("size-1.5 rounded-full shrink-0", statusDot(sess.status))} />
                    )}
                    {editing?.kind === "session" && editing.id === sess.session_id ? (
                      <Input
                        ref={editInputRef}
                        className="flex-1 h-5 pl-2 pr-2 py-0 text-xs min-w-0"
                        value={editValue}
                        onChange={e => onSetEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") onCommitEdit(); if (e.key === "Escape") onCancelEdit() }}
                        onBlur={e => onHandleEditBlur(e.relatedTarget)}
                        onClick={e => e.stopPropagation()}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                    ) : (
                      <span className="truncate flex-1">
                        {sess.title ?? "New Session"}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground/70 shrink-0 group-hover/sess:hidden">
                      {new Date(sess.created_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    {harness.access_role !== "viewer" && (
                      <>
                        {editing?.kind === "session" && editing.id === sess.session_id ? (
                          <button
                            data-edit-save
                            className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-primary hover:bg-primary/10 transition-colors shrink-0"
                            title="Save"
                            onClick={e => { e.stopPropagation(); onCommitEdit() }}
                          >
                            <Check className="size-3" />
                          </button>
                        ) : (
                          <button
                            className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
                            title="Rename"
                            onClick={e => { e.stopPropagation(); onStartEdit("session", sess.session_id, sess.title ?? "") }}
                          >
                            <Pencil className="size-3" />
                          </button>
                        )}
                        <button
                          className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          title="Delete session"
                          onClick={e => {
                            e.stopPropagation()
                            onSetDeleteTarget({ kind: "session", id: sess.session_id, harnessId: harness.harness_id })
                          }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </>
                    )}
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
