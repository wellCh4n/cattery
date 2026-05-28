"use client"

// ProjectMembersPanel — sidebar view for project membership. Shape mirrors
// the harness panel: h-9 title bar ("MEMBERS" + add button), then a body
// that lists the project owner (always first) followed by the members. Every
// member has full access; only the owner can add/remove members. Adding a
// member is a modal flow off the + button rather than an inline form.

import { useEffect, useState } from "react"
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createProjectMember,
  deleteProjectMember,
  listProjectMembers,
  searchUsers,
  type Project,
  type ProjectMember,
  type UserSummary,
} from "@/lib/api"

const MIN_REFRESH_SPIN_MS = 1000

interface Props {
  project: Project
  canManage: boolean
}

export function ProjectMembersPanel({ project, canManage }: Props) {
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  async function refreshMembers() {
    setRefreshing(true)
    const startedAt = Date.now()
    setLoading(true)
    setError(null)
    try {
      setMembers(await listProjectMembers(project.project_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load members")
    } finally {
      setLoading(false)
      const remaining = MIN_REFRESH_SPIN_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      listProjectMembers(project.project_id)
        .then(list => { if (!cancelled) setMembers(list) })
        .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "failed to load members") })
        .finally(() => { if (!cancelled) setLoading(false) })
    })
    return () => { cancelled = true }
  }, [project.project_id])

  async function removeMember(member: ProjectMember) {
    setBusy(member.user_id)
    setError(null)
    try {
      await deleteProjectMember(project.project_id, member.user_id)
      setMembers(list => list.filter(m => m.user_id !== member.user_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed")
    } finally {
      setBusy(null)
    }
  }

  function handleAdded(member: ProjectMember) {
    setMembers(list => [member, ...list.filter(m => m.user_id !== member.user_id)]
      .sort((a, b) => a.username.localeCompare(b.username)))
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Members
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refreshMembers()}
            disabled={refreshing}
            title="Refresh members"
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
          {canManage && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setAddOpen(true)}
              title="Add member"
            >
              <Plus />
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <MemberRow
          name={project.owner_username}
          isOwner={true}
          busy={false}
          canManage={false}
        />
        {loading ? (
          <div className="flex h-12 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          members.map(member => (
            <MemberRow
              key={member.user_id}
              name={member.username}
              isOwner={false}
              busy={busy === member.user_id}
              canManage={canManage}
              onRemove={() => removeMember(member)}
            />
          ))
        )}
        {error && <div className="px-2 pt-1 text-xs text-destructive">{error}</div>}
      </div>

      <AddMemberDialog
        project={project}
        open={addOpen}
        onOpenChange={setAddOpen}
        existingIds={new Set([project.owner_user_id, ...members.map(m => m.user_id)])}
        onAdded={handleAdded}
      />
    </div>
  )
}

function MemberRow({
  name,
  isOwner,
  busy,
  canManage,
  onRemove,
}: {
  name: string
  isOwner: boolean
  busy: boolean
  canManage: boolean
  onRemove?: () => void
}) {
  return (
    <div className="group flex h-7 cursor-pointer items-center gap-1.5 px-2 hover:bg-muted/60">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {isOwner ? (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">owner</span>
      ) : canManage ? (
        <button
          type="button"
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          disabled={busy}
          onClick={onRemove}
          title="Remove"
          aria-label="Remove"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
        </button>
      ) : (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">member</span>
      )}
    </div>
  )
}

function AddMemberDialog({
  project,
  open,
  onOpenChange,
  existingIds,
  onAdded,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  existingIds: Set<string>
  onAdded: (member: ProjectMember) => void
}) {
  const [query, setQuery] = useState("")
  const [candidates, setCandidates] = useState<UserSummary[]>([])
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setQuery("")
        setCandidates([])
        setSelectedUser(null)
        setBusy(false)
        setError(null)
      })
    }
  }, [open])

  useEffect(() => {
    if (!open || selectedUser) {
      queueMicrotask(() => setCandidates([]))
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      setSearching(true)
      searchUsers(query)
        .then(list => {
          if (cancelled) return
          setCandidates(list.filter(u => !existingIds.has(u.user_id)))
        })
        .catch(() => { if (!cancelled) setCandidates([]) })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, selectedUser, existingIds])

  async function submit() {
    if (!selectedUser) return
    setBusy(true)
    setError(null)
    try {
      const member = await createProjectMember(project.project_id, {
        username: selectedUser.username,
      })
      onAdded(member)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "add member failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Input
              autoFocus
              className="h-9 text-sm"
              placeholder="Search users"
              value={query}
              disabled={busy}
              onChange={e => {
                setQuery(e.target.value)
                setSelectedUser(null)
              }}
              onKeyDown={e => { if (e.key === "Enter" && selectedUser) void submit() }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {query && !selectedUser && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
                {searching ? (
                  <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
                    <Loader2 className="mr-1.5 size-3 animate-spin" />
                    Searching
                  </div>
                ) : candidates.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">No users found</div>
                ) : (
                  candidates.map(candidate => (
                    <button
                      key={candidate.user_id}
                      type="button"
                      className="flex h-8 w-full cursor-pointer items-center px-2 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setSelectedUser(candidate)
                        setQuery(candidate.username)
                        setCandidates([])
                      }}
                    >
                      <span className="truncate">{candidate.username}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!selectedUser || busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
