"use client"

// SkillBrowserPanel — global skill library browser. Backed by /api/v1/skills,
// proxied to the cluster-wide skillmgr Pod mounting the global skills PVC at
// /skills. Independent from FileBrowserPanel by design: skills
// have a different mental model (global library, top-level dir-per-skill
// convention) and we want their interactions free to diverge — so this is a
// trimmed reimplementation that shares only the lower-level Tree primitives
// and dialog atoms, not the file-browser layout.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  File as FileIcon,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/markdown"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import {
  createSkillFolder,
  deleteSkillFile,
  listSkills,
  readSkillFile,
  renameSkillFile,
  uploadSkillZip,
  type FileEntry,
  type FileReadResponse,
} from "@/lib/api"

const MIN_REFRESH_SPIN_MS = 1000

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"])

function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return MARKDOWN_EXTS.has(path.slice(dot + 1).toLowerCase())
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`
}

function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean)
  parts.pop()
  return parts.length === 0 ? "/" : "/" + parts.join("/")
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

type Opened = { path: string; data: FileReadResponse }

export function SkillBrowserPanel() {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [newFolderDir, setNewFolderDir] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const uploadDirRef = useRef<string>("/")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths(prev => new Set(prev).add(path))
    setError(null)
    try {
      const list = await listSkills(path)
      setChildrenByPath(prev => ({ ...prev, [path]: sortEntries(list) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load")
    } finally {
      setLoadingPaths(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadDir("/")
    })
    return () => { cancelled = true }
  }, [loadDir])

  async function refreshAll() {
    if (refreshing) return
    setRefreshing(true)
    const start = Date.now()
    try {
      const paths = ["/", ...Array.from(expanded)]
      await Promise.all(paths.map(p => loadDir(p)))
    } finally {
      const elapsed = Date.now() - start
      if (elapsed < MIN_REFRESH_SPIN_MS) {
        await new Promise(r => setTimeout(r, MIN_REFRESH_SPIN_MS - elapsed))
      }
      setRefreshing(false)
    }
  }

  function toggleExpand(path: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!childrenByPath[path]) void loadDir(path)
      }
      return next
    })
  }

  async function openFile(path: string) {
    setOpenLoading(true)
    try {
      const data = await readSkillFile(path)
      setOpened({ path, data })
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to open")
    } finally {
      setOpenLoading(false)
    }
  }

  async function uploadZipTo(targetDir: string, file: File) {
    setUploading(targetDir)
    try {
      await uploadSkillZip(targetDir, file)
      await loadDir(targetDir)
      setExpanded(prev => new Set(prev).add(targetDir))
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed")
    } finally {
      setUploading(null)
    }
  }

  async function commitRename(target: { entry: FileEntry; path: string }, trimmed: string) {
    if (trimmed === target.entry.name) return
    try {
      await renameSkillFile(target.path, trimmed)
      await loadDir(parentOf(target.path))
      if (opened && (opened.path === target.path || opened.path.startsWith(target.path + "/"))) {
        setOpened(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "rename failed")
    }
  }

  async function confirmDelete(target: { entry: FileEntry; path: string }) {
    try {
      await deleteSkillFile(target.path)
      await loadDir(parentOf(target.path))
      if (opened && (opened.path === target.path || opened.path.startsWith(target.path + "/"))) {
        setOpened(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed")
    }
  }

  function onPickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ""
    if (!file) return
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Skill upload accepts a .zip archive only.")
      return
    }
    void uploadZipTo(uploadDirRef.current, file)
  }

  function buildNode(entry: FileEntry, path: string): TreeNode {
    const isDir = entry.type === "dir"
    const isOpen = expanded.has(path)
    const isOpened = opened?.path === path
    const childEntries = isDir && isOpen ? childrenByPath[path] : undefined
    return {
      id: path,
      expandable: isDir,
      expanded: isOpen,
      loadingChildren: isDir && isOpen && loadingPaths.has(path) && !childEntries,
      children: childEntries
        ? childEntries.map(child => buildNode(child, joinPath(path, child.name)))
        : isDir && isOpen
          ? []
          : undefined,
      selected: isOpened,
      body: (
        <>
          {isDir ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </>
      ),
      actions: (
        <>
          {isDir && (
            <TreeRowAction
              title="Upload zip into this folder"
              aria-label="Upload zip"
              onClick={e => {
                e.stopPropagation()
                uploadDirRef.current = path
                fileInputRef.current?.click()
              }}
            >
              <Upload className="size-3.5" />
            </TreeRowAction>
          )}
          {isDir && (
            <TreeRowAction
              title="New folder"
              aria-label="New folder"
              onClick={e => {
                e.stopPropagation()
                setNewFolderDir(path)
              }}
            >
              <FolderPlus className="size-3.5" />
            </TreeRowAction>
          )}
          <TreeRowAction
            title="Rename"
            aria-label="Rename"
            onClick={e => {
              e.stopPropagation()
              setRenameTarget({ entry, path })
            }}
          >
            <Pencil className="size-3.5" />
          </TreeRowAction>
          <TreeRowAction
            destructive
            title="Delete"
            aria-label="Delete"
            onClick={e => {
              e.stopPropagation()
              setDeleteTarget({ entry, path })
            }}
          >
            <Trash2 className="size-3.5" />
          </TreeRowAction>
        </>
      ),
      onClick: () => {
        if (isDir) toggleExpand(path)
        else void openFile(path)
      },
    }
  }

  const rootChildren = childrenByPath["/"]
  const rootBusy = loadingPaths.has("/") && !rootChildren

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Skills
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="New top-level skill folder"
            onClick={() => setNewFolderDir("/")}
          >
            <FolderPlus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Upload skill zip to root"
            onClick={() => {
              uploadDirRef.current = "/"
              fileInputRef.current?.click()
            }}
          >
            <Upload />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Refresh"
            onClick={() => void refreshAll()}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".zip,application/zip" hidden onChange={onPickerChange} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && (
          <div className="px-3 py-2 text-xs text-destructive">{error}</div>
        )}
        {rootBusy && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </div>
        )}
        {!rootBusy && rootChildren && rootChildren.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
            <p>No skills yet.</p>
            <p>Create a top-level folder per skill, with a SKILL.md inside.</p>
          </div>
        )}
        {rootChildren && rootChildren.length > 0 && (
          <Tree items={rootChildren.map(entry => buildNode(entry, joinPath("/", entry.name)))} />
        )}
        {uploading && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Extracting zip into {uploading}…
          </div>
        )}
      </div>

      <NewFolderDialog
        dir={newFolderDir}
        onOpenChange={open => { if (!open) setNewFolderDir(null) }}
        onCreated={async dir => {
          setNewFolderDir(null)
          await loadDir(dir)
          setExpanded(prev => new Set(prev).add(dir))
        }}
      />

      <RenameDialog
        target={renameTarget}
        onOpenChange={open => { if (!open) setRenameTarget(null) }}
        onCommit={async (target, trimmed) => {
          setRenameTarget(null)
          await commitRename(target, trimmed)
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => { if (!open) setDeleteTarget(null) }}
        title={deleteTarget ? `Delete ${deleteTarget.entry.name}?` : "Delete?"}
        description={deleteTarget?.entry.type === "dir"
          ? "This deletes the folder and everything inside. This cannot be undone."
          : "This permanently deletes the file. This cannot be undone."}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteTarget) void confirmDelete(deleteTarget)
          setDeleteTarget(null)
        }}
      />

      <SkillFileDialog opened={opened} loading={openLoading} onClose={() => setOpened(null)} />
    </div>
  )
}

function NewFolderDialog({
  dir,
  onOpenChange,
  onCreated,
}: {
  dir: string | null
  onOpenChange: (open: boolean) => void
  onCreated: (dir: string) => void | Promise<void>
}) {
  return (
    <Dialog open={!!dir} onOpenChange={onOpenChange}>
      {dir && <NewFolderDialogContent key={dir} dir={dir} onOpenChange={onOpenChange} onCreated={onCreated} />}
    </Dialog>
  )
}

function NewFolderDialogContent({
  dir,
  onOpenChange,
  onCreated,
}: {
  dir: string
  onOpenChange: (open: boolean) => void
  onCreated: (dir: string) => void | Promise<void>
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setErr(null)
    try {
      await createSkillFolder(dir, trimmed)
      await onCreated(dir)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New folder</DialogTitle>
        <DialogDescription>
          Inside <span className="font-mono">{dir}</span>
        </DialogDescription>
      </DialogHeader>
      <Input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="folder name"
        onKeyDown={e => { if (e.key === "Enter") void commit() }}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={() => void commit()} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Create"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function RenameDialog({
  target,
  onOpenChange,
  onCommit,
}: {
  target: { entry: FileEntry; path: string } | null
  onOpenChange: (open: boolean) => void
  onCommit: (target: { entry: FileEntry; path: string }, trimmed: string) => void | Promise<void>
}) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      {target && <RenameDialogContent key={target.path} target={target} onOpenChange={onOpenChange} onCommit={onCommit} />}
    </Dialog>
  )
}

function RenameDialogContent({
  target,
  onOpenChange,
  onCommit,
}: {
  target: { entry: FileEntry; path: string }
  onOpenChange: (open: boolean) => void
  onCommit: (target: { entry: FileEntry; path: string }, trimmed: string) => void | Promise<void>
}) {
  const [name, setName] = useState(target.entry.name)

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === target.entry.name) {
      onOpenChange(false)
      return
    }
    await onCommit(target, trimmed)
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Rename</DialogTitle>
        <DialogDescription>
          Renaming <span className="font-mono">{target.entry.name}</span>
        </DialogDescription>
      </DialogHeader>
      <Input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") void commit() }}
      />
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={() => void commit()} disabled={!name.trim() || name.trim() === target.entry.name}>
          Rename
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function SkillFileDialog({
  opened,
  loading,
  onClose,
}: {
  opened: Opened | null
  loading: boolean
  onClose: () => void
}) {
  const isMd = opened ? isMarkdownPath(opened.path) : false
  return (
    <Dialog open={!!opened || loading} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{opened?.path ?? "Loading…"}</DialogTitle>
          <DialogDescription className="sr-only">
            Previewing the selected skill file.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] min-h-[200px] overflow-auto rounded border bg-muted/30 p-3 text-xs">
          {loading && <Loader2 className="size-4 animate-spin" />}
          {opened && opened.data.binary && (
            <p className="text-muted-foreground">Binary file ({opened.data.size} bytes) — preview not supported.</p>
          )}
          {opened && !opened.data.binary && isMd && (
            <Markdown>{opened.data.content ?? ""}</Markdown>
          )}
          {opened && !opened.data.binary && !isMd && (
            <pre className="whitespace-pre-wrap break-words font-mono">{opened.data.content ?? ""}</pre>
          )}
          {opened && opened.data.truncated && (
            <p className="mt-2 text-muted-foreground">Output truncated.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
