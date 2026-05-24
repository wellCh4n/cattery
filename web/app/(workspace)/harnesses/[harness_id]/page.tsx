"use client"

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  ChevronRight,
  Clock,
  Check,
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
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

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
    if (next === (harness.harness_name ?? "").trim()) {
      setEditingName(false)
      return
    }
    setRenaming(true)
    try {
      await renameHarness(harness.harness_id, next)
      setEditingName(false)
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

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <header className="flex items-start gap-3 border-b pb-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/30">
            <HarnessIcon id={harness.type} className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {editingName ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Input
                    className="h-8 max-w-sm text-base font-semibold"
                    value={nameValue}
                    disabled={renaming}
                    onChange={e => setNameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") void commitRename()
                      if (e.key === "Escape") setEditingName(false)
                    }}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button size="icon-sm" disabled={renaming} onClick={commitRename} title="Save">
                    {renaming ? <Loader2 className="animate-spin" /> : <Check />}
                  </Button>
                </div>
              ) : (
                <h1 className="truncate text-xl font-semibold">{harness.harness_name ?? "Untitled"}</h1>
              )}
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
            </div>
          </div>
          {isOwner && !editingName && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setNameValue(harness.harness_name ?? "")
                  setEditingName(true)
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
                className="text-muted-foreground hover:text-destructive"
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

        <section className="grid gap-4 md:grid-cols-3">
          <InfoBlock label="Created" value={new Date(harness.created_at).toLocaleString()} icon={<CalendarDays className="size-4" />} />
          <InfoBlock label="Transport" value={harness.transport_kind} icon={<Bot className="size-4" />} />
          <InfoBlock label="Sessions" value={`${sessions.length}`} icon={<MessagesSquare className="size-4" />} />
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Sessions</h2>
          </div>
          {sessions.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center rounded-md border text-muted-foreground">
              <MessagesSquare className="mb-2 size-5" />
              <p className="text-sm">No sessions</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              {sessions.map(session => (
                <button
                  key={session.session_id}
                  className="flex h-12 w-full cursor-pointer items-center gap-3 border-b px-3 text-left last:border-b-0 hover:bg-muted/50"
                  onClick={() => router.push(`/sessions/${session.session_id}`)}
                >
                  <span className={cn("size-2 rounded-full", statusDot(session.status))} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{session.title ?? "New Session"}</div>
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
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Environment Variables</h2>
          <EnvVars vars={harness.env_vars ?? {}} />
        </section>
      </div>

      <ShareHarnessDialog
        harness={harness}
        open={shareOpen}
        onOpenChange={setShareOpen}
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

function statusDot(status: string) {
  if (status === "ready") return "bg-emerald-500"
  if (status === "failed") return "bg-destructive"
  return "bg-amber-400"
}

function InfoBlock({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="truncate text-sm font-medium">{value}</div>
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
