"use client"

import { useEffect, useState } from "react"
import { Loader2, Plus, Share2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createHarnessShare,
  deleteHarnessShare,
  listHarnessShares,
  searchUsers,
  updateHarnessShare,
  type Harness,
  type HarnessShare,
  type UserSummary,
} from "@/lib/api"

interface Props {
  harness: Harness | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShareHarnessDialog({ harness, open, onOpenChange }: Props) {
  const [shares, setShares] = useState<HarnessShare[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [candidates, setCandidates] = useState<UserSummary[]>([])
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null)
  const [searching, setSearching] = useState(false)
  const [role, setRole] = useState<"viewer" | "editor">("editor")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !harness) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      listHarnessShares(harness.harness_id)
        .then(list => { if (!cancelled) setShares(list) })
        .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "failed to load shares") })
        .finally(() => { if (!cancelled) setLoading(false) })
    })
    return () => { cancelled = true }
  }, [harness, open])

  function reset() {
    setQuery("")
    setCandidates([])
    setSelectedUser(null)
    setSearching(false)
    setRole("editor")
    setError(null)
    setBusy(null)
  }

  useEffect(() => {
    if (!open || !harness || selectedUser) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      setSearching(true)
      searchUsers(query)
        .then(list => {
          if (cancelled) return
          const excluded = new Set<string>([harness.owner_user_id, ...shares.map(s => s.user_id)])
          setCandidates(list.filter(u => !excluded.has(u.user_id)))
        })
        .catch(() => { if (!cancelled) setCandidates([]) })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [harness, open, query, selectedUser, shares])

  async function addShare() {
    if (!harness) return
    if (!selectedUser) return
    setBusy("add")
    setError(null)
    try {
      const share = await createHarnessShare(harness.harness_id, { username: selectedUser.username, role })
      setShares(list => [share, ...list.filter(s => s.user_id !== share.user_id)].sort((a, b) => a.username.localeCompare(b.username)))
      setQuery("")
      setCandidates([])
      setSelectedUser(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "share failed")
    } finally {
      setBusy(null)
    }
  }

  async function changeRole(share: HarnessShare, nextRole: "viewer" | "editor") {
    if (!harness) return
    setBusy(share.user_id)
    setError(null)
    try {
      const updated = await updateHarnessShare(harness.harness_id, share.user_id, { role: nextRole })
      setShares(list => list.map(s => s.user_id === updated.user_id ? updated : s))
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed")
    } finally {
      setBusy(null)
    }
  }

  async function removeShare(share: HarnessShare) {
    if (!harness) return
    setBusy(share.user_id)
    setError(null)
    try {
      await deleteHarnessShare(harness.harness_id, share.user_id)
      setShares(list => list.filter(s => s.user_id !== share.user_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-4 text-muted-foreground" />
            Share harness
          </DialogTitle>
          <DialogDescription>
            {harness?.harness_name ?? "Untitled"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                className="h-9"
                placeholder="Search users"
                value={query}
                disabled={busy !== null}
                onChange={e => {
                  setQuery(e.target.value)
                  setSelectedUser(null)
                }}
                onKeyDown={e => { if (e.key === "Enter" && selectedUser) void addShare() }}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {query && !selectedUser && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
                  {searching ? (
                    <div className="flex h-9 items-center px-2 text-xs text-muted-foreground">
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
            <RoleSelect value={role} disabled={busy !== null} onChange={setRole} />
            <Button disabled={!selectedUser || busy !== null} onClick={addShare}>
              {busy === "add" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add
            </Button>
          </div>

          {loading ? (
            <div className="flex h-20 items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : shares.length === 0 ? (
            <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
              Not shared
            </div>
          ) : (
            <div className="rounded-md border divide-y divide-border/60">
              {shares.map(share => (
                <div key={share.user_id} className="flex items-center gap-2 px-3 py-2">
                  <span className="truncate flex-1 text-sm">{share.username}</span>
                  <RoleSelect
                    value={share.role}
                    disabled={busy !== null}
                    onChange={next => changeRole(share, next)}
                  />
                  <button
                    className="inline-flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={() => removeShare(share)}
                    title="Remove"
                  >
                    {busy === share.user_id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: "viewer" | "editor"
  disabled?: boolean
  onChange: (value: "viewer" | "editor") => void
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value as "viewer" | "editor")}
      className="h-9 rounded border bg-background px-2 text-xs text-foreground disabled:opacity-50"
    >
      <option value="editor">editor</option>
      <option value="viewer">viewer</option>
    </select>
  )
}
