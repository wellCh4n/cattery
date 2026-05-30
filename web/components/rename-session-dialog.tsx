"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
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
import { type Session } from "@/lib/api"
import { useWorkspaceStore } from "@/lib/workspace-store"

interface Props {
  session: Session | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RenameSessionDialog({ session, open, onOpenChange }: Props) {
  const renameSession = useWorkspaceStore(state => state.renameSession)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && session) setValue(session.title ?? "")
  }, [open, session])

  async function commit() {
    if (!session) return
    const next = value.trim()
    const current = (session.title ?? "").trim()
    if (!next || next === current) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    try {
      await renameSession(session.session_id, next)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const currentTitle = (session?.title ?? "").trim()
  const disabled = saving || !value.trim() || value.trim() === currentTitle

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (saving) return
        if (o && session) setValue(session.title ?? "")
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Give this session a new display name.</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          disabled={saving}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Session title"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={disabled}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
