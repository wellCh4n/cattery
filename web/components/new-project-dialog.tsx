"use client"

import { useRef, useState } from "react"
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
  const savingRef = useRef(false)

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (savingRef.current) return
        onOpenChange(next)
      }}
    >
      <NewProjectForm
        savingRef={savingRef}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    </Dialog>
  )
}

function NewProjectForm({
  savingRef,
  onOpenChange,
  onCreated,
}: {
  savingRef: { current: boolean }
  onOpenChange: (open: boolean) => void
  onCreated?: (project: ProjectWithHarnesses) => void
}) {
  const createProject = useWorkspaceStore(state => state.createProject)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  async function commit() {
    if (saving) return
    savingRef.current = true
    setSaving(true)
    try {
      const trimmed = value.trim()
      const project = await createProject(trimmed.length === 0 ? null : trimmed)
      savingRef.current = false
      setSaving(false)
      onOpenChange(false)
      onCreated?.(project)
    } catch (err) {
      savingRef.current = false
      setSaving(false)
      throw err
    }
  }

  return (
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
  )
}
