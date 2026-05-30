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
import { type Project } from "@/lib/api"
import { useWorkspaceStore } from "@/lib/workspace-store"

interface Props {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RenameProjectDialog({ project, open, onOpenChange }: Props) {
  const renameProject = useWorkspaceStore(state => state.renameProject)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && project) setValue(project.project_name ?? "")
  }, [open, project])

  async function commit() {
    if (!project) return
    const next = value.trim()
    const current = (project.project_name ?? "").trim()
    if (!next || next === current) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    try {
      await renameProject(project.project_id, next)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const currentName = (project?.project_name ?? "").trim()
  const disabled = saving || !value.trim() || value.trim() === currentName

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (saving) return
        if (o && project) setValue(project.project_name ?? "")
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>Give this project a new display name.</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          disabled={saving}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Project name"
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
