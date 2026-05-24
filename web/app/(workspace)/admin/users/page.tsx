"use client"

import { FormEvent, useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, KeyRound, Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUser,
  type AdminUser,
} from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"

export default function AdminUsersPage() {
  const router = useRouter()
  const me = useAuthStore(s => s.user)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  // refresh re-fetches users; the on-mount fetch lives in its own effect
  // (below) with a cancellation flag so React strict-mode double-runs and
  // unmount-during-flight don't end up writing stale state.
  const refresh = useCallback(async () => {
    try {
      const list = await adminListUsers()
      setUsers(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load users")
    }
  }, [])

  // Bounce non-admins back to /. They shouldn't see the menu link, but
  // someone might type the URL directly — server still 403s, but a quiet
  // redirect is friendlier than an error screen.
  useEffect(() => {
    if (me && !me.is_admin) router.replace("/")
  }, [me, router])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await adminListUsers()
        if (cancelled) return
        setUsers(list)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : "failed to load users")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/")}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
            title="Back"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-lg font-semibold flex-1">Users</h1>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5 mr-1" />
            Add user
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive mb-4">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Username</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Last login</th>
                  <th className="px-3 py-2 font-medium w-px"></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isMe = me?.user_id === u.user_id
                  return (
                    <tr key={u.user_id} className="border-t group">
                      <td className="px-3 py-2 truncate">
                        {u.username}
                        {isMe && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                      </td>
                      <td className="px-3 py-2">
                        <RoleBadge user={u} disabled={isMe} onChange={refresh} setError={setError} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {u.last_login_at
                          ? new Date(u.last_login_at).toLocaleString()
                          : <span className="italic">never</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button
                          className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center size-7 rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer transition"
                          title="Reset password"
                          onClick={() => setResetTarget(u)}
                        >
                          <KeyRound className="size-3.5" />
                        </button>
                        <button
                          className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center size-7 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:cursor-not-allowed transition"
                          title={isMe ? "You cannot delete yourself" : "Delete"}
                          disabled={isMe}
                          onClick={() => setDeleteTarget(u)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={refresh}
      />
      <ResetPasswordDialog
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        onDone={refresh}
      />
      <DeleteUserDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDone={refresh}
      />
    </div>
  )
}

function RoleBadge({
  user,
  disabled,
  onChange,
  setError,
}: {
  user: AdminUser
  disabled: boolean
  onChange: () => void
  setError: (s: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  async function toggle() {
    if (disabled) return
    setBusy(true)
    setError(null)
    try {
      await adminUpdateUser(user.user_id, { is_admin: !user.is_admin })
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed")
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      onClick={toggle}
      disabled={disabled || busy}
      className={disabled ? "cursor-default" : "cursor-pointer"}
      title={disabled ? "You cannot change your own role" : "Toggle admin"}
    >
      <Badge variant={user.is_admin ? "default" : "secondary"} className="text-[10px] h-5 px-2 font-normal">
        {busy ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
        {user.is_admin ? "admin" : "member"}
      </Badge>
    </button>
  )
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() { setUsername(""); setPassword(""); setIsAdmin(false); setError(null) }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await adminCreateUser({ username: username.trim(), password, is_admin: isAdmin })
      onCreated()
      onOpenChange(false)
      reset()
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) reset() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Set an initial password. The user can change it from their account menu after signing in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cu-username">Username</Label>
            <Input
              id="cu-username"
              type="text"
              autoCapitalize="off"
              spellCheck={false}
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={busy}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cu-password">Password</Label>
            <Input
              id="cu-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={e => setIsAdmin(e.target.checked)}
              disabled={busy}
            />
            Grant admin privileges
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({
  target,
  onClose,
  onDone,
}: {
  target: AdminUser | null
  onClose: () => void
  onDone: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent>
        {/* key={target.user_id} forces a fresh form (with empty state) every
            time the admin opens this dialog for a different user — no need
            for a useEffect to clear password / error. */}
        {target && (
          <ResetPasswordForm
            key={target.user_id}
            target={target}
            onCancel={onClose}
            onDone={() => { onDone(); onClose() }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordForm({
  target,
  onCancel,
  onDone,
}: {
  target: AdminUser
  onCancel: () => void
  onDone: () => void
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await adminUpdateUser(target.user_id, { password })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : "reset failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Reset password</DialogTitle>
        <DialogDescription>
          Set a new password for <strong>{target.username}</strong>. They can change it themselves after signing in.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="rp-password">New password</Label>
          <Input
            id="rp-password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={busy}
            required
            autoFocus
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
            Reset
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

function DeleteUserDialog({
  target,
  onClose,
  onDone,
}: {
  target: AdminUser | null
  onClose: () => void
  onDone: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false}>
        {target && (
          <DeleteUserConfirm
            key={target.user_id}
            target={target}
            onCancel={onClose}
            onDone={() => { onDone(); onClose() }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeleteUserConfirm({
  target,
  onCancel,
  onDone,
}: {
  target: AdminUser
  onCancel: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConfirm() {
    setBusy(true)
    setError(null)
    try {
      await adminDeleteUser(target.user_id)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-destructive" />
          Delete user
        </DialogTitle>
        <DialogDescription>
          Delete <strong>{target.username}</strong>?
        </DialogDescription>
      </DialogHeader>
      <p className="text-xs text-destructive leading-relaxed">
        This permanently removes the user, all their harnesses, sessions, and stops every
        associated sandbox. Workspace data inside those sandboxes is lost.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
          Delete
        </Button>
      </DialogFooter>
    </>
  )
}
