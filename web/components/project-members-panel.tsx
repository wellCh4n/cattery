"use client"

// ProjectMembersPanel — sidebar view for project membership. Shape mirrors
// the harness panel: h-9 title bar ("MEMBERS" + manage button), then a body
// that lists the project owner (always first) followed by the members. Every
// member has full access; only the owner can add/remove members. Managing
// members is a transfer-box modal off the + button: all users on the left,
// current members on the right, both searchable — left→right adds, right→left
// removes.

import { useEffect, useMemo, useState } from "react"
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TreeRow, TreeRowAction } from "@/components/tree-row"
import {
  Dialog,
  DialogContent,
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
// The transfer box lists the whole directory on the left; ask for the store's
// ceiling rather than the default 20-row autocomplete cap.
const DIRECTORY_LIMIT = 50

interface Props {
  project: Project
  canManage: boolean
}

export function ProjectMembersPanel({ project, canManage }: Props) {
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
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
    setMembers(list => [...list.filter(m => m.user_id !== member.user_id), member]
      .sort((a, b) => a.username.localeCompare(b.username)))
  }

  function handleRemoved(userId: string) {
    setMembers(list => list.filter(m => m.user_id !== userId))
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
              onClick={() => setManageOpen(true)}
              title="Manage members"
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

      <ManageMembersDialog
        project={project}
        open={manageOpen}
        onOpenChange={setManageOpen}
        members={members}
        onAdded={handleAdded}
        onRemoved={handleRemoved}
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
    <TreeRow className="px-2">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {isOwner || !canManage ? (
        <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">
          {isOwner ? "owner" : "member"}
        </Badge>
      ) : (
        <>
          <Badge
            variant="secondary"
            className="h-4 shrink-0 px-1.5 text-[10px] font-normal group-hover/treerow:hidden"
          >
            member
          </Badge>
          <TreeRowAction
            destructive
            disabled={busy}
            onClick={e => { e.stopPropagation(); onRemove?.() }}
            title="Remove member"
            aria-label="Remove member"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </TreeRowAction>
        </>
      )}
    </TreeRow>
  )
}

// ManageMembersDialog is a transfer box (穿梭框): all users on the left, the
// project's current members on the right. Selecting rows on either side and
// hitting the center arrow applies the change immediately — left→right calls
// createProjectMember, right→left calls deleteProjectMember — and reports each
// result up so the sidebar list stays in sync. The owner is never listed; they
// cannot be removed.
function ManageMembersDialog({
  project,
  open,
  onOpenChange,
  members,
  onAdded,
  onRemoved,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  members: ProjectMember[]
  onAdded: (member: ProjectMember) => void
  onRemoved: (userId: string) => void
}) {
  const [allUsers, setAllUsers] = useState<UserSummary[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [leftQuery, setLeftQuery] = useState("")
  const [rightQuery, setRightQuery] = useState("")
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set())
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setLeftQuery("")
        setRightQuery("")
        setLeftSelected(new Set())
        setRightSelected(new Set())
        setBusy(false)
        setError(null)
      })
      return
    }
    let cancelled = false
    setLoadingUsers(true)
    searchUsers("", DIRECTORY_LIMIT)
      .then(list => { if (!cancelled) setAllUsers(list) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "failed to load users") })
      .finally(() => { if (!cancelled) setLoadingUsers(false) })
    return () => { cancelled = true }
  }, [open])

  const memberIds = useMemo(() => new Set(members.map(m => m.user_id)), [members])

  // Left = directory minus the owner and anyone already a member.
  const leftUsers = useMemo(() => {
    const q = leftQuery.trim().toLowerCase()
    return allUsers
      .filter(u => u.user_id !== project.owner_user_id && !memberIds.has(u.user_id))
      .filter(u => !q || u.username.toLowerCase().includes(q))
  }, [allUsers, leftQuery, memberIds, project.owner_user_id])

  const rightMembers = useMemo(() => {
    const q = rightQuery.trim().toLowerCase()
    return members.filter(m => !q || m.username.toLowerCase().includes(q))
  }, [members, rightQuery])

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  async function addSelected() {
    const picked = leftUsers.filter(u => leftSelected.has(u.user_id))
    if (picked.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const user of picked) {
        const member = await createProjectMember(project.project_id, { username: user.username })
        onAdded(member)
      }
      setLeftSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : "add member failed")
    } finally {
      setBusy(false)
    }
  }

  async function removeSelected() {
    const picked = rightMembers.filter(m => rightSelected.has(m.user_id))
    if (picked.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const member of picked) {
        await deleteProjectMember(project.project_id, member.user_id)
        onRemoved(member.user_id)
      }
      setRightSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove member failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Manage members</DialogTitle>
        </DialogHeader>
        <div className="flex items-stretch gap-2">
          <TransferList
            title="All users"
            search={leftQuery}
            onSearch={setLeftQuery}
            empty={loadingUsers ? "Loading" : "No users"}
            loading={loadingUsers}
            disabled={busy}
            items={leftUsers.map(u => ({ id: u.user_id, label: u.username }))}
            selected={leftSelected}
            onToggle={id => setLeftSelected(s => toggle(s, id))}
          />

          <div className="flex flex-col items-center justify-center gap-2">
            <Button
              size="icon-sm"
              variant="outline"
              disabled={busy || leftSelected.size === 0}
              onClick={addSelected}
              title="Add selected"
              aria-label="Add selected"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              disabled={busy || rightSelected.size === 0}
              onClick={removeSelected}
              title="Remove selected"
              aria-label="Remove selected"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronLeft className="size-4" />}
            </Button>
          </div>

          <TransferList
            title={`Members (${members.length})`}
            search={rightQuery}
            onSearch={setRightQuery}
            empty="No members"
            loading={false}
            disabled={busy}
            items={rightMembers.map(m => ({ id: m.user_id, label: m.username }))}
            selected={rightSelected}
            onToggle={id => setRightSelected(s => toggle(s, id))}
          />
        </div>
        {error && <div className="pt-1 text-xs text-destructive">{error}</div>}
      </DialogContent>
    </Dialog>
  )
}

function TransferList({
  title,
  search,
  onSearch,
  items,
  selected,
  onToggle,
  empty,
  loading,
  disabled,
}: {
  title: string
  search: string
  onSearch: (value: string) => void
  items: { id: string; label: string }[]
  selected: Set<string>
  onToggle: (id: string) => void
  empty: string
  loading: boolean
  disabled: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-md border">
      <div className="border-b px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="p-1.5">
        <Input
          className="h-8 text-sm"
          placeholder="Search"
          value={search}
          disabled={disabled}
          onChange={e => onSearch(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
      <div className="h-56 overflow-y-auto px-1.5 pb-1.5">
        {loading ? (
          <div className="flex h-8 items-center px-1 text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 size-3 animate-spin" />
            {empty}
          </div>
        ) : items.length === 0 ? (
          <div className="px-1 py-2 text-xs text-muted-foreground">{empty}</div>
        ) : (
          items.map(item => {
            const active = selected.has(item.id)
            return (
              <button
                key={item.id}
                type="button"
                role="checkbox"
                aria-checked={active}
                disabled={disabled}
                onClick={() => onToggle(item.id)}
                className="flex h-7 w-full cursor-pointer items-center gap-2 rounded px-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <span
                  className={
                    "flex size-4 shrink-0 items-center justify-center rounded-[4px] border " +
                    (active ? "border-primary bg-primary text-primary-foreground" : "border-input")
                  }
                >
                  {active && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
