"use client"

import { useState } from "react"
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
import { type Terminal, useTerminalStore } from "@/lib/terminal-store"

// Mount with key={terminal.terminal_id} so the input starts from that terminal's title.
export function RenameTerminalDialog({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const renameTerminal = useTerminalStore(state => state.renameTerminal)
  const [value, setValue] = useState(terminal.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = value.trim()
  const disabled = saving || !next || next === terminal.title

  async function commit() {
    if (disabled) return
    setSaving(true)
    setError(null)
    try {
      await renameTerminal(terminal.terminal_id, next)
      onClose()
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to rename terminal") }
    finally { setSaving(false) }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename terminal</DialogTitle>
          <DialogDescription>Give this terminal a new display name.</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          disabled={saving}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Terminal name"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={commit} disabled={disabled}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
