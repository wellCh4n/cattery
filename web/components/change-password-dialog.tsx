"use client"

import { FormEvent, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAuthStore } from "@/lib/auth-store"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const changePassword = useAuthStore(s => s.changePassword)
  const [oldPassword, setOldPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  function reset() {
    setOldPassword("")
    setNewPassword("")
    setConfirm("")
    setError(null)
    setSuccess(false)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirm) {
      setError("New passwords do not match")
      return
    }
    setBusy(true)
    try {
      await changePassword(oldPassword, newPassword)
      setSuccess(true)
      setTimeout(() => {
        onOpenChange(false)
        reset()
      }, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Change password failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) reset() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Your current token stays valid until it expires. Sign out and back in if you want it rotated.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="old">Current password</Label>
            <Input
              id="old"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new">New password</Label>
            <Input
              id="new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm new password</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {success && <p className="text-xs text-emerald-600">Password updated</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              Update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
