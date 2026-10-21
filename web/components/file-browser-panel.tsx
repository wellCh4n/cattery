"use client"

// FileBrowserPanel — lazy-loaded tree of the project's /work workspace. Listing
// comes from the per-project filemgr Pod via the backend proxy. Folders expand/collapse
// in place (children fetched on first expand); clicking a file opens it in a
// large modal viewer (uses the existing FileViewer with shiki highlighting).
// Per-row hover actions: folders reveal rename/upload/delete (upload writes
// directly into that folder), files reveal rename/delete. Rename and new-folder
// both go through dialogs for consistency. Two drag flows: dropping OS files
// on a folder (or on blank space, for root) uploads; dragging an existing
// entry onto another folder moves it there.

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
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
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { cn } from "@/lib/utils"
import { tabHref } from "@/lib/tabs-store"
import {
  createFolder,
  deleteFile,
  listFiles,
  moveFile,
  renameFile,
  uploadFile,
  type FileEntry,
} from "@/lib/api"

const MIN_REFRESH_SPIN_MS = 1000

interface Props {
  projectId: string
  active: boolean
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`
}

function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean)
  parts.pop()
  return parts.length === 0 ? "/" : "/" + parts.join("/")
}

// Folders first, then files; alphabetical within each group.
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function FileBrowserPanel({ projectId, active }: Props) {
  const router = useRouter()
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [newFolderDir, setNewFolderDir] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const dragDepthRef = useRef(0)
  const uploadDirRef = useRef<string>("/")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  const refreshInFlight = useRef(false)
  const requestVersions = useRef(new Map<string, number>())

  const loadDir = useCallback(async (path: string) => {
    const version = (requestVersions.current.get(path) ?? 0) + 1
    requestVersions.current.set(path, version)
    setLoadingPaths(prev => new Set(prev).add(path))
    try {
      const list = sortEntries(await listFiles(projectId, path))
      if (requestVersions.current.get(path) !== version) return null
      // A successful parent listing is authoritative, including deleted folders.
      const directories = new Set(list.filter(entry => entry.type === "dir").map(entry => joinPath(path, entry.name)))
      const prefix = path === "/" ? "/" : `${path}/`
      const removed = (candidate: string) => {
        if (candidate === path || !candidate.startsWith(prefix)) return false
        const child = prefix + candidate.slice(prefix.length).split("/")[0]
        return !directories.has(child)
      }
      for (const [candidate, pendingVersion] of requestVersions.current) {
        if (removed(candidate)) requestVersions.current.set(candidate, pendingVersion + 1)
      }
      setChildrenByPath(prev => ({
        ...Object.fromEntries(Object.entries(prev).filter(([candidate]) => !removed(candidate))),
        [path]: list,
      }))
      setExpanded(prev => new Set([...prev].filter(candidate => !removed(candidate))))
      setLoadingPaths(prev => new Set([...prev].filter(candidate => !removed(candidate))))
      return list
    } catch (e) {
      if (requestVersions.current.get(path) === version) {
        setError(e instanceof Error ? e.message : "failed to load")
      }
      return null
    } finally {
      if (requestVersions.current.get(path) === version) {
        setLoadingPaths(prev => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    }
  }, [projectId])

  // Restore after showing the still-mounted tree or replacing its listings.
  // Scroll events keep this current if the user scrolls during a refresh.
  useLayoutEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = scrollTopRef.current
  }, [active, childrenByPath, error])

  const refreshOnActivate = useEffectEvent(() => { void refresh() })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) refreshOnActivate() })
    return () => { cancelled = true }
  }, [active])

  function toggleExpand(path: string) {
    const opening = !expanded.has(path)
    setExpanded(prev => {
      const next = new Set(prev)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
    if (opening && !childrenByPath[path]) void loadDir(path)
  }

  // Open a file as a tab in the main pane (FileView renders it there).
  function openFile(path: string) {
    router.push(tabHref({ kind: "file", id: path, projectId }))
  }

  async function uploadFiles(targetDir: string, files: File[]) {
    if (files.length === 0) return
    setUploading(targetDir)
    try {
      for (const file of files) {
        await uploadFile(projectId, targetDir, file)
      }
      setExpanded(prev => targetDir === "/" ? prev : new Set(prev).add(targetDir))
      await loadDir(targetDir)
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(null)
    }
  }

  async function commitRename(path: string, nextName: string): Promise<boolean> {
    const trimmed = nextName.trim()
    const name = path.split("/").pop() ?? ""
    if (!trimmed || trimmed === name) return false
    try {
      await renameFile(projectId, path, trimmed)
      await loadDir(parentOf(path))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename failed")
      return false
    }
  }

  async function confirmDelete(path: string) {
    await deleteFile(projectId, path)
    await loadDir(parentOf(path))
  }

  // moveEntry moves `from` into directory `toDir`. Refuses no-ops and the
  // obvious cycle case (folder into itself or its own descendant) before
  // hitting the network so the user gets instant feedback.
  async function moveEntry(from: string, toDir: string) {
    if (from === toDir) return
    if (parentOf(from) === toDir) return
    if (toDir === from || toDir.startsWith(from + "/")) {
      setError("Can't move a folder into itself")
      return
    }
    try {
      await moveFile(projectId, from, toDir)
      const fromParent = parentOf(from)
      await Promise.all([
        loadDir(fromParent),
        loadDir(toDir),
      ])
      if (toDir !== "/") {
        setExpanded(prev => new Set(prev).add(toDir))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "move failed")
    }
  }

  async function afterFolderCreated(dir: string) {
    setExpanded(prev => dir === "/" ? prev : new Set(prev).add(dir))
    await loadDir(dir)
  }

  async function refresh() {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    setError(null)
    const startedAt = Date.now()
    const paths = new Set(expanded)
    try {
      // Refresh parents first so deleted subtrees are never requested.
      // Collapsed ancestors are traversed only when they contain remembered expansions.
      const visit = async (path: string): Promise<void> => {
        const entries = await loadDir(path)
        if (!entries) return
        await Promise.all(entries.filter(entry => entry.type === "dir").map(async entry => {
          const child = joinPath(path, entry.name)
          if (paths.has(child) || [...paths].some(p => p.startsWith(`${child}/`))) {
            await visit(child)
          }
        }))
      }
      await visit("/")
    } finally {
      const remaining = MIN_REFRESH_SPIN_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = "" // allow re-selecting the same file later
    await uploadFiles(uploadDirRef.current, files)
  }

  function triggerUpload(dir: string) {
    uploadDirRef.current = dir
    fileInputRef.current?.click()
  }

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const isItem = e.dataTransfer.types.includes("application/x-cattery-tree-item")
    e.dataTransfer.dropEffect = isItem ? "move" : "copy"
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    // Internal item drag → move into root. Row-level handlers stop propagation
    // so this only fires when dropped on the empty area (or root listing).
    const itemPath = e.dataTransfer.getData("application/x-cattery-tree-item")
    if (itemPath) {
      await moveEntry(itemPath, "/")
      return
    }
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) await uploadFiles("/", files)
  }

  const rootChildren = childrenByPath["/"]
  const rootBusy = loadingPaths.has("/")

  function buildFileNode(entry: FileEntry, path: string): TreeNode {
    const isDir = entry.type === "dir"
    const isExpanded = isDir && expanded.has(path)
    const childEntries = isExpanded ? childrenByPath[path] : undefined
    return {
      id: path,
      expandable: isDir,
      expanded: isExpanded,
      loadingChildren: loadingPaths.has(path),
      children: isDir
        ? (childEntries ? childEntries.map(c => buildFileNode(c, joinPath(path, c.name))) : undefined)
        : undefined,
      onClick: () => isDir ? toggleExpand(path) : openFile(path),
      onFilesDropped: isDir ? files => uploadFiles(path, files) : undefined,
      dragId: path,
      onItemDropped: isDir ? sourcePath => moveEntry(sourcePath, path) : undefined,
      body: (
        <>
          {!isDir && <FileIcon className="size-3.5 shrink-0 text-muted-foreground/70" />}
          <span className="truncate flex-1">{entry.name}</span>
          {!isDir && (
            <span className="hidden sm:inline text-[10px] text-muted-foreground/60 shrink-0 group-hover/treerow:hidden">
              {formatSize(entry.size)}
            </span>
          )}
        </>
      ),
      actions: (
        <>
          <TreeRowAction
            onClick={e => { e.stopPropagation(); setRenameTarget({ entry, path }) }}
            title="Rename"
            aria-label="Rename"
          >
            <Pencil className="size-3.5" />
          </TreeRowAction>
          {isDir && (
            <TreeRowAction
              onClick={e => { e.stopPropagation(); setNewFolderDir(path) }}
              title="New folder"
              aria-label="New folder"
            >
              <FolderPlus className="size-3.5" />
            </TreeRowAction>
          )}
          {isDir && (
            <TreeRowAction
              onClick={e => { e.stopPropagation(); triggerUpload(path) }}
              disabled={uploading === path}
              title="Upload here"
              aria-label="Upload here"
            >
              {uploading === path ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            </TreeRowAction>
          )}
          <TreeRowAction
            destructive
            onClick={e => { e.stopPropagation(); setDeleteTarget({ entry, path }) }}
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 className="size-3.5" />
          </TreeRowAction>
        </>
      ),
    }
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Files
        </span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onUpload}
        />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Refresh files"
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => triggerUpload("/")}
            disabled={uploading !== null}
            title="Upload to /"
          >
            {uploading === "/" ? <Loader2 className="animate-spin" /> : <Upload />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setNewFolderDir("/")}
            title="New folder in /"
          >
            <FolderPlus />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={event => {
          if (active) scrollTopRef.current = event.currentTarget.scrollTop
        }}
        className={cn(
          "relative flex-1 min-h-0 overflow-y-auto transition-colors",
          dragging && "bg-muted/30 ring-1 ring-inset ring-ring"
        )}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {error && (
          <div className="p-4 text-destructive">{error}</div>
        )}
        {!error && rootChildren === undefined && rootBusy && (
          <div className="flex min-h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        )}
        {!error && rootChildren !== undefined && rootChildren.length === 0 && !rootBusy && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Folder className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">No files</p>
            <div className="mt-3 flex w-32 flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => triggerUpload("/")}
                disabled={uploading !== null}
              >
                {uploading !== null ? <Loader2 className="animate-spin" /> : <Upload />}
                Upload
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setNewFolderDir("/")}
              >
                <FolderPlus />
                New folder
              </Button>
            </div>
          </div>
        )}
        {rootChildren && rootChildren.length > 0 && (
          <Tree items={rootChildren.map(entry => buildFileNode(entry, joinPath("/", entry.name)))} />
        )}
      </div>

      <NewFolderDialog
        projectId={projectId}
        dir={newFolderDir}
        onOpenChange={open => { if (!open) setNewFolderDir(null) }}
        onCreated={afterFolderCreated}
      />

      <RenameDialog
        target={renameTarget}
        onOpenChange={open => { if (!open) setRenameTarget(null) }}
        onCommit={async name => {
          if (!renameTarget) return false
          return commitRename(renameTarget.path, name)
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={open => { if (!open) setDeleteTarget(null) }}
        title={deleteTarget?.entry.type === "dir" ? "Delete folder?" : "Delete file?"}
        description={
          <>
            {deleteTarget?.entry.type === "dir"
              ? "Recursively delete "
              : "Delete "}
            <span className="font-mono text-foreground">{deleteTarget?.entry.name}</span>
            ? This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (deleteTarget) await confirmDelete(deleteTarget.path)
        }}
      />
    </div>
  )
}

function NewFolderDialog({
  projectId,
  dir,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  dir: string | null
  onOpenChange: (open: boolean) => void
  onCreated: (dir: string) => void | Promise<void>
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed || busy || !dir) return
    setBusy(true)
    setError(null)
    try {
      await createFolder(projectId, dir, trimmed)
      await onCreated(dir)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "create folder failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={dir !== null}
      onOpenChange={o => {
        if (busy) return
        if (o) { setName(""); setError(null) }
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a folder in <span className="font-mono text-foreground">{dir ?? ""}</span>.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          disabled={busy}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Folder name"
        />
        {error && <div className="text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// RenameDialog — dialog-based rename for files and folders. Mirrors
// NewFolderDialog's shape so the two stay visually consistent.
function RenameDialog({
  target,
  onOpenChange,
  onCommit,
}: {
  target: { entry: FileEntry; path: string } | null
  onOpenChange: (open: boolean) => void
  onCommit: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setName(target.entry.name)
      setError(null)
    })
    return () => { cancelled = true }
  }, [target])

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed || busy || !target) return
    if (trimmed === target.entry.name) {
      onOpenChange(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await onCommit(trimmed)
      if (ok) onOpenChange(false)
      else setError("rename failed")
    } catch (e) {
      setError(e instanceof Error ? e.message : "rename failed")
    } finally {
      setBusy(false)
    }
  }

  const isDir = target?.entry.type === "dir"
  return (
    <Dialog
      open={target !== null}
      onOpenChange={o => {
        if (busy) return
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDir ? "Rename folder" : "Rename file"}</DialogTitle>
          <DialogDescription>
            Rename <span className="font-mono text-foreground">{target?.entry.name ?? ""}</span>.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          disabled={busy}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit() }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={isDir ? "Folder name" : "File name"}
        />
        {error && <div className="text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}
