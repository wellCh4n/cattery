"use client"

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Clock,
  Cable,
  Eraser,
  Loader2,
  MessagesSquare,
  Pencil,
  Play,
  Share2,
  Shield,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import { HarnessIcon } from "@/components/harness-icon"
import { ModelIcon } from "@/components/model-icon"
import { ShareHarnessDialog } from "@/components/share-harness-dialog"
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
  const harness = useWorkspaceStore(state =>
    state.harnesses.find(h => h.harness_id === harness_id) ?? null
  )
  const loaded = useWorkspaceStore(state => state.loaded)
  const loadHarnesses = useWorkspaceStore(state => state.loadHarnesses)
  const createSession = useWorkspaceStore(state => state.createSession)
  const renameHarness = useWorkspaceStore(state => state.renameHarness)
  const deleteHarness = useWorkspaceStore(state => state.deleteHarness)
  const purgeDeadSessions = useWorkspaceStore(state => state.purgeDeadSessions)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameValue, setNameValue] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [purgeOpen, setPurgeOpen] = useState(false)

  useEffect(() => {
    if (loaded && harness) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadHarnesses().catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load harness")
      })
    })
    return () => { cancelled = true }
  }, [harness, loadHarnesses, loaded])

  async function handleNewSession(h: HarnessWithSessions) {
    if (h.sandbox_status !== "ready" || h.access_role === "viewer") return
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

  if (!loaded || !harness) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  const sessions = harness.sessions.filter(s => s.status !== "dead")
  const canCreate = harness.sandbox_status === "ready" && harness.access_role !== "viewer"
  const isOwner = harness.access_role === "owner"

  const envCount = Object.keys(harness.env_vars ?? {}).length

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-6">
        <header className="flex items-start gap-3 border-b pb-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/30">
            <HarnessIcon id={harness.type} className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{harness.harness_name ?? "Untitled"}</h1>
              <Badge variant={harness.access_role === "owner" ? "default" : "secondary"} className="h-5 text-[10px] font-normal">
                {harness.access_role}
              </Badge>
              <SandboxBadge status={harness.sandbox_status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <HarnessIcon id={harness.type} className="size-3.5" />
                {TYPE_LABELS[harness.type] ?? harness.type}
              </span>
              <span className="inline-flex items-center gap-1">
                <ModelIcon id={harness.model} className="size-3.5" />
                {harness.model}
              </span>
              <span className="inline-flex items-center gap-1">
                <Shield className="size-3.5" />
                {harness.owner_username}
              </span>
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-3.5" />
                {new Date(harness.created_at).toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <Cable className="size-3.5" />
                {harness.transport_kind}
              </span>
              <span className="inline-flex items-center gap-1">
                <MessagesSquare className="size-3.5" />
                {sessions.length} sessions
              </span>
            </div>
          </div>
          {isOwner && (
            <>
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
                onClick={() => setShareOpen(true)}
                title="Share"
              >
                <Share2 />
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
            </>
          )}
          <Button
            size="sm"
            disabled={!canCreate || launching}
            onClick={() => handleNewSession(harness)}
            title={harness.access_role === "viewer" ? "Viewer access" : harness.sandbox_status === "ready" ? "New session" : "Sandbox is not ready"}
          >
            {launching ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            New session
          </Button>
        </header>

        <section className="shrink-0">
          <div className="mb-1.5 flex items-center justify-between px-0.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Sessions{sessions.length > 0 ? ` (${sessions.length})` : ""}
            </div>
            {isOwner && (
              <button
                type="button"
                onClick={() => setPurgeOpen(true)}
                className="inline-flex h-5 cursor-pointer items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Permanently remove dead sessions from this harness"
              >
                <Eraser className="size-3" />
                Clean up dead sessions
              </button>
            )}
          </div>
          <div className="max-h-[40vh] overflow-y-auto rounded-md border">
            <SessionsList sessions={sessions} onOpenSession={id => router.push(`/sessions/${id}`)} />
          </div>
        </section>

        <Tabs defaultValue="files" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="env">
              Environment Variables{envCount > 0 ? ` (${envCount})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="mt-2 min-h-0 flex-1">
            <div className="h-full overflow-hidden rounded-md border">
              <FileBrowserPanel harness={harness} />
            </div>
          </TabsContent>
          <TabsContent value="env" className="mt-2 min-h-0 flex-1 overflow-y-auto">
            <EnvVars vars={harness.env_vars ?? {}} />
          </TabsContent>
        </Tabs>
      </div>

      <ShareHarnessDialog
        harness={harness}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

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

      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title="Clean up dead sessions?"
        description={
          <>
            Permanently delete every session in{" "}
            <span className="font-medium text-foreground">{harness.harness_name ?? "Untitled"}</span>{" "}
            whose sandbox has died. This cannot be undone.
          </>
        }
        confirmLabel="Clean up"
        destructive
        onConfirm={async () => {
          await purgeDeadSessions(harness.harness_id)
          await loadHarnesses()
        }}
      />
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

function statusDot(status: string) {
  if (status === "ready") return "bg-emerald-500"
  if (status === "failed") return "bg-destructive"
  return "bg-amber-400"
}

function SessionsList({
  sessions,
  onOpenSession,
}: {
  sessions: HarnessWithSessions["sessions"]
  onOpenSession: (sessionId: string) => void
}) {
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
        <button
          key={session.session_id}
          className="flex h-12 w-full cursor-pointer items-center gap-3 border-b px-3 text-left last:border-b-0 hover:bg-muted/50"
          onClick={() => onOpenSession(session.session_id)}
        >
          <span className={cn("size-2 rounded-full", statusDot(session.status))} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs">{session.title ?? "New Session"}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="size-3" />
              {new Date(session.last_seen_at ?? session.created_at).toLocaleString()}
            </div>
          </div>
          <Badge variant={session.status === "ready" ? "default" : session.status === "failed" ? "destructive" : "secondary"} className="h-5 text-[10px]">
            {session.status}
          </Badge>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
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
