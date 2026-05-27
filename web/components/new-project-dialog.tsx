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
import { useWorkspaceStore, type ProjectWithHarnesses } from "@/lib/workspace-store"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (project: ProjectWithHarnesses) => void
}

export function NewProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const createProject = useWorkspaceStore(state => state.createProject)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setValue("")
      setSaving(false)
    }
  }, [open])

  async function commit() {
    if (saving) return
    setSaving(true)
    try {
      const trimmed = value.trim()
      const project = await createProject(trimmed.length === 0 ? null : trimmed)
      onOpenChange(false)
      onCreated?.(project)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (saving) return
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A workspace volume is provisioned the moment the project is created. Leave the name blank to use the default.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          disabled={saving}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Project name (optional)"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
