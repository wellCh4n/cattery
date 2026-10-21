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

// Mount with key={terminal.id} so the input starts from that terminal's title.
export function RenameTerminalDialog({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const renameTerminal = useTerminalStore(state => state.renameTerminal)
  const [value, setValue] = useState(terminal.title)
  const next = value.trim()
  const disabled = !next || next === terminal.title

  function commit() {
    if (!disabled) renameTerminal(terminal.id, next)
    onClose()
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename terminal</DialogTitle>
          <DialogDescription>Give this terminal a new display name.</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Terminal name"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={commit} disabled={disabled}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
