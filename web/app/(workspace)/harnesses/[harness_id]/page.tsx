"use client"

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Clock,
  Cable,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Play,
  Shield,
  Terminal,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { HarnessIcon } from "@/components/harness-icon"
import { ModelIcon } from "@/components/model-icon"
import { RenameSessionDialog } from "@/components/rename-session-dialog"
import { type Session, type TransportKind } from "@/lib/api"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { type HarnessWithSessions, useWorkspaceStore } from "@/lib/workspace-store"

interface PageParams {
  harness_id: string
}

const TYPE_LABELS: Record<string, string> = {
  "opencode":    "OpenCode",
  "claude-code": "Claude Code",
  "codex":       "Codex",
  "hermes":      "Hermes",
}

export default function HarnessPage({ params }: { params: Promise<PageParams> }) {
  const { harness_id } = use(params)
  const router = useRouter()
  const harness = useWorkspaceStore(state => {
    for (const project of state.projects) {
      const harness = project.harnesses.find(h => h.harness_id === harness_id)
      if (harness) return harness
    }
    return null
  })
  const project = useWorkspaceStore(state => {
    for (const project of state.projects) {
      if (project.harnesses.some(h => h.harness_id === harness_id)) return project
    }
    return null
  })
  const loaded = useWorkspaceStore(state => state.loaded)
  const loadProjects = useWorkspaceStore(state => state.loadProjects)
  const createSession = useWorkspaceStore(state => state.createSession)
  const renameHarness = useWorkspaceStore(state => state.renameHarness)
  const deleteHarness = useWorkspaceStore(state => state.deleteHarness)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameValue, setNameValue] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [renameSessionTarget, setRenameSessionTarget] = useState<Session | null>(null)
  const [renameSessionOpen, setRenameSessionOpen] = useState(false)

  useDocumentTitle(harness ? (harness.harness_name ?? "Untitled") : null)

  useEffect(() => {
    if (loaded && harness) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadProjects().catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load harness")
      })
    })
    return () => { cancelled = true }
  }, [harness, loadProjects, loaded])

  async function handleNewSession(h: HarnessWithSessions) {
    if (h.sandbox_status !== "ready") return
    setLaunching(true)
    try {
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
      const session = await createSession(h, theme)
      router.push(`/sessions/${session.session_id}`)
    } finally {
      setLaunching(false)
    }
  }

  async function commitRename() {
    if (!harness) return
    const next = nameValue.trim()
    if (!next || next === (harness.harness_name ?? "").trim()) {
      setRenameOpen(false)
      return
    }
    setRenaming(true)
    try {
      await renameHarness(harness.harness_id, next)
      setRenameOpen(false)
    } finally {
      setRenaming(false)
    }
  }

  async function confirmDelete() {
    if (!harness) return
    setDeleting(true)
    try {
      await deleteHarness(harness.harness_id)
      router.push("/")
    } finally {
      setDeleting(false)
    }
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center px-6">
        <div className="rounded-full bg-destructive/10 p-4 mb-4">
          <AlertTriangle className="size-7 text-destructive" />
        </div>
        <p className="text-sm font-medium">{error}</p>
      </div>
    )
  }

  if (!loaded || !harness || !project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  const sessions = harness.sessions.filter(s => s.status !== "dead")
  const canCreate = harness.sandbox_status === "ready"
  const isOwner = harness.access_role === "owner"

  const envCount = Object.keys(harness.env_vars ?? {}).length

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-6">
        <header className="flex flex-col gap-4 border-b pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted/30 sm:size-12">
              <HarnessIcon id={harness.type} className="size-6 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <h1 className="min-w-0 truncate text-xl font-semibold">{harness.harness_name ?? "Untitled"}</h1>
                <Badge variant={harness.access_role === "owner" ? "default" : "secondary"} className="h-5 text-[10px] font-normal">
                  {harness.access_role}
                </Badge>
                <SandboxBadge status={harness.sandbox_status} />
              </div>
              <div className="mt-2 grid gap-x-4 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <HarnessIcon id={harness.type} className="size-3.5" />
                  <span className="min-w-0 truncate">{TYPE_LABELS[harness.type] ?? harness.type}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <ModelIcon id={harness.model} className="size-3.5" />
                  <span className="min-w-0 truncate">{harness.model}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Shield className="size-3.5" />
                  <span className="min-w-0 truncate">{project.project_name ?? "Untitled Project"}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <CalendarDays className="size-3.5" />
                  <span className="min-w-0 break-words">{new Date(harness.created_at).toLocaleString()}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Cable className="size-3.5" />
                  <span className="min-w-0 truncate">{harness.transport_kind}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MessagesSquare className="size-3.5" />
                  <span className="min-w-0 truncate">{sessions.length} sessions</span>
                </span>
              </div>
            </div>
          </div>
          <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 self-start lg:w-auto lg:justify-end lg:pt-0.5">
            {isOwner && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setNameValue(harness.harness_name ?? "")
                    setRenameOpen(true)
                  }}
                  title="Rename"
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleteOpen(true)}
                  title="Delete harness"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 />
                </Button>
              </div>
            )}
            <Button
              size="sm"
              disabled={!canCreate || launching}
              onClick={() => handleNewSession(harness)}
              title={harness.sandbox_status === "ready" ? "New session" : "Sandbox is not ready"}
              className="max-[420px]:w-full"
            >
              {launching ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              New session
            </Button>
          </div>
        </header>

        <section className="shrink-0">
          <div className="mb-1.5 flex items-center justify-between px-0.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Sessions{sessions.length > 0 ? ` (${sessions.length})` : ""}
            </div>
          </div>
          <div className="max-h-[40vh] overflow-y-auto rounded-md border">
            <SessionsList
              sessions={sessions}
              transportKind={harness.transport_kind}
              onOpenSession={id => router.push(`/sessions/${id}`)}
              onRenameSession={sess => {
                setRenameSessionTarget(sess)
                setRenameSessionOpen(true)
              }}
            />
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 mb-2 text-xs font-medium text-muted-foreground">
            Environment Variables{envCount > 0 ? ` (${envCount})` : ""}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EnvVars vars={harness.env_vars ?? {}} />
          </div>
        </section>
      </div>

      <Dialog open={renameOpen} onOpenChange={open => { if (!renaming) setRenameOpen(open) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename harness</DialogTitle>
            <DialogDescription>Give this harness a new display name.</DialogDescription>
          </DialogHeader>
          <Input
            value={nameValue}
            disabled={renaming}
            onChange={e => setNameValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void commitRename() }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Harness name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)} disabled={renaming}>
              Cancel
            </Button>
            <Button
              onClick={commitRename}
              disabled={renaming || !nameValue.trim() || nameValue.trim() === (harness.harness_name ?? "").trim()}
            >
              {renaming ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RenameSessionDialog
        session={renameSessionTarget}
        open={renameSessionOpen}
        onOpenChange={setRenameSessionOpen}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete harness</DialogTitle>
            <DialogDescription>
              Delete <strong>{harness.harness_name ?? "Untitled"}</strong> and all its sessions? This will also stop the sandbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

function SandboxBadge({ status }: { status: string }) {
  if (status === "ready") {
    return <Badge className="h-5 bg-emerald-500/15 text-[10px] text-emerald-700 border-emerald-500/30 dark:text-emerald-400">ready</Badge>
  }
  if (status === "failed") return <Badge variant="destructive" className="h-5 text-[10px]">failed</Badge>
  return <Badge variant="secondary" className="h-5 text-[10px]">{status}</Badge>
}

// Color for the session type icon: failed/starting stand out, ready stays muted.
function sessionIconColor(status: string): string {
  if (status === "failed") return "text-destructive"
  if (status !== "ready") return "text-amber-500 animate-pulse"
  return "text-muted-foreground"
}

function SessionsList({
  sessions,
  transportKind,
  onOpenSession,
  onRenameSession,
}: {
  sessions: HarnessWithSessions["sessions"]
  transportKind: TransportKind
  onOpenSession: (sessionId: string) => void
  onRenameSession: (session: Session) => void
}) {
  const SessionIcon = transportKind === "terminal" ? Terminal : MessageSquare
  if (sessions.length === 0) {
    return (
      <div className="flex min-h-32 flex-col items-center justify-center text-muted-foreground">
        <MessagesSquare className="mb-2 size-5" />
        <p className="text-sm">No sessions</p>
      </div>
    )
  }
  return (
    <div>
      {sessions.map(session => (
        <div
          key={session.session_id}
          role="button"
          tabIndex={0}
          className="group flex h-12 w-full cursor-pointer items-center gap-3 border-b px-3 text-left last:border-b-0 hover:bg-muted/50"
          onClick={() => onOpenSession(session.session_id)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenSession(session.session_id) } }}
        >
          <SessionIcon className={cn("size-4 shrink-0", sessionIconColor(session.status))} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs">{session.title ?? "New Session"}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="size-3" />
              {new Date(session.last_seen_at ?? session.created_at).toLocaleString()}
            </div>
          </div>
          <button
            type="button"
            title="Rename session"
            aria-label="Rename session"
            onClick={e => { e.stopPropagation(); onRenameSession(session) }}
            className="hidden size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground group-hover:inline-flex"
          >
            <Pencil className="size-3.5" />
          </button>
          <Badge variant={session.status === "ready" ? "default" : session.status === "failed" ? "destructive" : "secondary"} className="h-5 text-[10px]">
            {session.status}
          </Badge>
          <ChevronRight className="size-4 text-muted-foreground" />
        </div>
      ))}
    </div>
  )
}

function EnvVars({ vars }: { vars: Record<string, string> }) {
  const entries = Object.entries(vars)
  if (entries.length === 0) {
    return (
      <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
        None
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border">
      {entries.map(([key, value]) => (
        <div key={key} className="grid gap-1 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[180px_1fr]">
          <code className="break-all text-xs font-medium">{key}</code>
          <code className="break-all whitespace-pre-wrap text-xs text-muted-foreground">{value}</code>
        </div>
      ))}
    </div>
  )
}
