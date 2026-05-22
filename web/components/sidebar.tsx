"use client"

import { useState, useEffect, useCallback, useRef } from "react"
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
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { CreateHarnessDialog } from "@/components/create-harness-dialog"
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
import {
  listHarnesses,
  listSessions,
  createSession,
  deleteHarness,
  deleteSession,
  getHarness,
  getSession,
  updateHarness,
  updateSessionTitle,
  type Harness,
  type Session,
} from "@/lib/api"

interface HarnessWithSessions extends Harness {
  sessions: Session[]
  expanded: boolean
}

type DeleteTarget =
  | { kind: "harness"; id: string; name: string }
  | { kind: "session"; id: string; harnessId: string }

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const selectedSessionId = pathname.startsWith("/sessions/")
    ? pathname.slice("/sessions/".length)
    : null
  const [harnesses, setHarnesses] = useState<HarnessWithSessions[]>([])
  const [launching, setLaunching] = useState<string | null>(null)
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState<{ kind: "harness"; id: string; original: string } | { kind: "session"; id: string; original: string } | null>(null)
  const [editValue, setEditValue] = useState("")
  const editInputRef = useRef<HTMLInputElement>(null)
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
        const updated = await updateHarness(editing.id, { harness_name: val })
        setHarnesses(prev => prev.map(h => h.harness_id === editing.id ? { ...h, harness_name: updated.harness_name } : h))
      } else {
        const updated = await updateSessionTitle(editing.id, { title: val })
        setHarnesses(prev => prev.map(h => ({
          ...h,
          sessions: h.sessions.map(s => s.session_id === editing.id ? { ...s, title: updated.title } : s),
        })))
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

  const loadHarnesses = useCallback(async () => {
    const list = await listHarnesses()
    const withSessions = await Promise.all(
      list.map(async h => ({ harness: h, sessions: await listSessions(h.harness_id).catch(() => []) }))
    )
    setHarnesses(prev =>
      withSessions.map(({ harness, sessions }) => {
        const existing = prev.find(p => p.harness_id === harness.harness_id)
        return { ...harness, sessions, expanded: existing?.expanded ?? true }
      })
    )
  }, [])

  useEffect(() => {
    loadHarnesses()
  }, [loadHarnesses])

  useEffect(() => {
    function onTitle(e: Event) {
      const { sessionId, title } = (e as CustomEvent<{ sessionId: string; title: string }>).detail
      setHarnesses(prev => prev.map(h => ({
        ...h,
        sessions: h.sessions.map(s =>
          s.session_id === sessionId ? { ...s, title } : s
        ),
      })))
    }
    function onBusy(e: Event) {
      const { sessionId, busy } = (e as CustomEvent<{ sessionId: string; busy: boolean }>).detail
      setBusySessions(prev => {
        const next = new Set(prev)
        if (busy) next.add(sessionId); else next.delete(sessionId)
        return next
      })
    }
    window.addEventListener("cattery:title", onTitle)
    window.addEventListener("cattery:session-busy", onBusy)
    return () => {
      window.removeEventListener("cattery:title", onTitle)
      window.removeEventListener("cattery:session-busy", onBusy)
    }
  }, [])

  async function toggleExpand(harnessId: string) {
    setHarnesses(prev => prev.map(h => {
      if (h.harness_id !== harnessId) return h
      if (!h.expanded && h.sessions.length === 0) {
        loadSessionsFor(harnessId)
      }
      return { ...h, expanded: !h.expanded }
    }))
  }

  async function loadSessionsFor(harnessId: string) {
    const sessions = await listSessions(harnessId)
    setHarnesses(prev => prev.map(h =>
      h.harness_id === harnessId ? { ...h, sessions, expanded: true } : h
    ))
  }

  async function handleNewSession(harness: HarnessWithSessions) {
    setLaunching(harness.harness_id)
    try {
      // 把当前页面主题透给 codex —— 它只在启动时探一次 OSC 10/11，
      // 之后用户在浏览器里切主题，codex 那边不会同步变。
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
      const session = await createSession(harness.harness_id, theme)
      setHarnesses(prev => prev.map(h =>
        h.harness_id === harness.harness_id
          ? { ...h, sessions: [session, ...h.sessions], expanded: true }
          : h
      ))
      router.push(`/sessions/${session.session_id}`)
      pollSessionStatus(session.session_id, harness.harness_id)
    } finally {
      setLaunching(null)
    }
  }

  function pollSessionStatus(sessionId: string, harnessId: string) {
    const timer = setInterval(async () => {
      try {
        const updated = await getSession(sessionId)
        if (updated.status !== "creating") {
          clearInterval(timer)
        }
        setHarnesses(prev => prev.map(h =>
          h.harness_id === harnessId
            ? { ...h, sessions: h.sessions.map(s => s.session_id === sessionId ? updated : s) }
            : h
        ))
      } catch {
        clearInterval(timer)
      }
    }, 1500)
  }

  // 持续轮询所有未到终态的 harness sandbox，直到 ready / failed。
  // 不只盯 starting 是因为：harness 刚创建时 DB 还是 idle，要等后端 goroutine
  // 写 starting；这段窗口前端如果只看 starting 就永远不会刷新。依赖 pollingKey
  // (id 串) 而不是整个 harnesses 数组，避免每次状态变更都重建定时器。
  const pollingKey = harnesses
    .filter(h => h.sandbox_status !== "ready" && h.sandbox_status !== "failed")
    .map(h => h.harness_id)
    .sort()
    .join(",")
  useEffect(() => {
    if (!pollingKey) return
    const ids = pollingKey.split(",")
    const timer = setInterval(async () => {
      const updates = await Promise.all(ids.map(id => getHarness(id).catch(() => null)))
      setHarnesses(prev => prev.map(h => {
        const u = updates.find(x => x?.harness_id === h.harness_id)
        return u && u.sandbox_status !== h.sandbox_status
          ? { ...h, sandbox_status: u.sandbox_status }
          : h
      }))
    }, 1500)
    return () => clearInterval(timer)
  }, [pollingKey])

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.kind === "harness") {
        const removed = harnesses.find(h => h.harness_id === deleteTarget.id)
        await deleteHarness(deleteTarget.id)
        setHarnesses(prev => prev.filter(h => h.harness_id !== deleteTarget.id))
        if (removed?.sessions.some(s => s.session_id === selectedSessionId)) {
          router.push("/")
        }
      } else {
        await deleteSession(deleteTarget.id)
        setHarnesses(prev => prev.map(h =>
          h.harness_id === deleteTarget.harnessId
            ? { ...h, sessions: h.sessions.filter(s => s.session_id !== deleteTarget.id) }
            : h
        ))
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
              onCreated={harness =>
                setHarnesses(prev => [{ ...harness, sessions: [], expanded: true }, ...prev])
              }
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
          {harnesses.map(harness => (
            <div key={harness.harness_id} className="px-1.5 mb-1">
              <div className="group flex items-center gap-0.5 rounded-md pl-1 pr-0.5 h-8 hover:bg-muted transition-colors">
                <button
                  className="flex-1 flex cursor-pointer items-center gap-1.5 min-w-0 h-full text-left text-sm font-medium outline-none"
                  onClick={() => toggleExpand(harness.harness_id)}
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 text-muted-foreground transition-transform shrink-0",
                      harness.expanded && "rotate-90"
                    )}
                  />
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
                      className="flex-1 h-6 pl-4 pr-2 py-0 text-sm font-medium min-w-0"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") cancelEdit() }}
                      onBlur={e => handleEditBlur(e.relatedTarget)}
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
                        {TYPE_LABELS[harness.type] ?? harness.type}
                      </Badge>
                    </>
                  )}
                </button>
                <button
                  className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50 transition-colors"
                  title="New session"
                  disabled={launching === harness.harness_id}
                  onClick={() => handleNewSession(harness)}
                >
                  {launching === harness.harness_id
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Plus className="size-3.5" />}
                </button>
                {editing?.kind === "harness" && editing.id === harness.harness_id ? (
                  <button
                    data-edit-save
                    className="inline-flex cursor-pointer items-center justify-center size-6 rounded text-primary hover:bg-primary/10 transition-colors"
                    title="Save"
                    onClick={commitEdit}
                  >
                    <Check className="size-3.5" />
                  </button>
                ) : (
                  <button
                    className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                    title="Rename"
                    onClick={() => startEdit("harness", harness.harness_id, harness.harness_name ?? "")}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
                <button
                  className="hidden group-hover:inline-flex focus-visible:inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Delete harness"
                  onClick={() => setDeleteTarget({ kind: "harness", id: harness.harness_id, name: harness.harness_name ?? "Untitled" })}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

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
                        onClick={() => router.push(`/sessions/${sess.session_id}`)}
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
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") cancelEdit() }}
                            onBlur={e => handleEditBlur(e.relatedTarget)}
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
                        {editing?.kind === "session" && editing.id === sess.session_id ? (
                          <button
                            data-edit-save
                            className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-primary hover:bg-primary/10 transition-colors shrink-0"
                            title="Save"
                            onClick={e => { e.stopPropagation(); commitEdit() }}
                          >
                            <Check className="size-3" />
                          </button>
                        ) : (
                          <button
                            className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
                            title="Rename"
                            onClick={e => { e.stopPropagation(); startEdit("session", sess.session_id, sess.title ?? "") }}
                          >
                            <Pencil className="size-3" />
                          </button>
                        )}
                        <button
                          className="hidden group-hover/sess:inline-flex cursor-pointer items-center justify-center size-4 rounded text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          title="Delete session"
                          onClick={e => {
                            e.stopPropagation()
                            setDeleteTarget({ kind: "session", id: sess.session_id, harnessId: harness.harness_id })
                          }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

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
