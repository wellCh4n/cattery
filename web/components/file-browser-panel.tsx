"use client"

// FileBrowserPanel — lazy-loaded tree of the project's home workspace. Listing
// comes from the project's agent via the backend proxy. Folders expand/collapse
// in place (children fetched on first expand); clicking a file opens it in a
// large modal viewer (uses the existing FileViewer with shiki highlighting).
// Per-row hover actions: folders reveal rename/new folder/new file/upload/delete
// (upload writes directly into that folder), files reveal rename/delete. Rename,
// new-folder and new-file all go through dialogs for consistency. Two drag flows: dropping OS files
// on a folder (or on blank space, for root) uploads; dragging an existing
// entry onto another folder moves it there.

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
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
import { tabForPath, tabHref } from "@/lib/tabs-store"
import {
  type FileEntry,
} from "@/lib/api"

import { fileActions, fileKey, refreshFiles, useFilesStore } from "@/lib/files-store"
import { RefreshButton } from "@/components/refresh-button"

interface Props {
  projectId: string
  active: boolean
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`
}

const SHOW_HIDDEN_KEY = "cattery:files:show-hidden"

function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean)
  parts.pop()
  return parts.length === 0 ? "/" : "/" + parts.join("/")
}

export function FileBrowserPanel({ projectId, active }: Props) {
  const router = useRouter()
  const currentTab = tabForPath(usePathname())
  const selectedPath = currentTab?.kind === "file" && currentTab.projectId === projectId
    ? currentTab.id
    : null
  const resources = useFilesStore(state => state.entries)
  // Dotfiles and dot-folders (.git, .cattery, ...) are hidden unless toggled on.
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(SHOW_HIDDEN_KEY) === "1")
  const { childrenByPath, loadingPaths, loadError } = useMemo(() => {
    const childrenByPath: Record<string, FileEntry[]> = {}
    const loadingPaths = new Set<string>()
    let loadError: string | null = null
    for (const [key, resource] of Object.entries(resources)) {
      const [project, path] = JSON.parse(key) as [string, string]
      if (project !== projectId) continue
      if (resource.data) {
        childrenByPath[path] = showHidden ? resource.data : resource.data.filter(entry => !entry.name.startsWith("."))
      }
      if (resource.loading) loadingPaths.add(path)
      if (resource.error) loadError = resource.error
    }
    return { childrenByPath, loadingPaths, loadError }
  }, [resources, projectId, showHidden])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [refreshRequested, setRefreshing] = useState(false)
  const refreshing = refreshRequested || loadingPaths.size > 0
  const [actionError, setError] = useState<string | null>(null)
  const error = actionError ?? loadError
  const [uploading, setUploading] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [newEntry, setNewEntry] = useState<{ kind: EntryKind; dir: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const dragDepthRef = useRef(0)
  const uploadDirRef = useRef<string>("/")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  const loadDir = useCallback((path: string) =>
    useFilesStore.getState().load(fileKey(projectId, path)), [projectId])

  useEffect(() => {
    // Prune expansion only after a successful parent listing proves removal.
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setExpanded(prev => {
        const next = new Set([...prev].filter(path => {
          for (let child = path; child !== "/"; child = parentOf(child)) {
            const parent = childrenByPath[parentOf(child)]
            if (parent && !parent.some(entry => entry.type === "dir" && joinPath(parentOf(child), entry.name) === child)) return false
          }
          return true
        }))
        return next.size === prev.size ? prev : next
      })
    })
    return () => { cancelled = true }
  }, [childrenByPath])

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

  const revealSelection = useEffectEvent(async (path: string, cancelled: () => boolean) => {
    const parents: string[] = []
    for (let parent = parentOf(path); parent !== "/"; parent = parentOf(parent)) {
      parents.unshift(parent)
    }
    if (parents.length === 0 || cancelled()) return
    setExpanded(prev => new Set([...prev, ...parents]))
    for (const parent of parents) {
      if (cancelled()) return
      if (!childrenByPath[parent] && await loadDir(parent) === null) return
    }
  })

  useEffect(() => {
    if (!active || !selectedPath) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void revealSelection(selectedPath, () => cancelled)
    })
    return () => { cancelled = true }
  }, [active, selectedPath])

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
      await fileActions.upload(projectId, targetDir, files)
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
      await fileActions.rename(projectId, path, trimmed)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename failed")
      return false
    }
  }

  async function confirmDelete(path: string) {
    await fileActions.remove(projectId, path)
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
      await fileActions.move(projectId, from, toDir)
      if (toDir !== "/") {
        setExpanded(prev => new Set(prev).add(toDir))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "move failed")
    }
  }

  async function afterEntryCreated(kind: EntryKind, dir: string, path: string) {
    setExpanded(prev => dir === "/" ? prev : new Set(prev).add(dir))
    await loadDir(dir)
    if (kind === "file") openFile(path)
  }

  async function refresh() {
    setRefreshing(true)
    setError(null)
    try { await refreshFiles(projectId, [...expanded]) }
    finally { setRefreshing(false) }
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
      selected: !isDir && path === selectedPath,
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
          {!isDir && <FileIcon className="size-4 shrink-0 text-muted-foreground/70" />}
          <span className="truncate flex-1">{entry.name}</span>
          {!isDir && (
            <span className="hidden sm:inline text-xs text-muted-foreground shrink-0 group-hover/treerow:hidden">
              {formatSize(entry.size)}
            </span>
          )}
        </>
      ),
      actions: (
        <>
          <TreeRowAction
            onClick={e => { e.stopPropagation(); setRenameTarget({ entry, path }) }}
            aria-label="Rename"
          >
            <Pencil className="size-4" />
          </TreeRowAction>
          {isDir && (
            <TreeRowAction
              onClick={e => { e.stopPropagation(); setNewEntry({ kind: "folder", dir: path }) }}
              aria-label="New folder"
            >
              <FolderPlus className="size-4" />
            </TreeRowAction>
          )}
          {isDir && (
            <TreeRowAction
              onClick={e => { e.stopPropagation(); setNewEntry({ kind: "file", dir: path }) }}
              aria-label="New file"
            >
              <FilePlus className="size-4" />
            </TreeRowAction>
          )}
          {isDir && (
            <TreeRowAction
              onClick={e => { e.stopPropagation(); triggerUpload(path) }}
              disabled={uploading === path}
              aria-label="Upload here"
            >
              {uploading === path ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            </TreeRowAction>
          )}
          <TreeRowAction
            destructive
            onClick={e => { e.stopPropagation(); setDeleteTarget({ entry, path }) }}
            aria-label="Delete"
          >
            <Trash2 className="size-4" />
          </TreeRowAction>
        </>
      ),
    }
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between px-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
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
          <RefreshButton onClick={() => void refresh()} refreshing={refreshing} aria-label="Refresh files" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? "0" : "1")
              setShowHidden(!showHidden)
            }}
            aria-pressed={showHidden}
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          >
            {showHidden ? <Eye /> : <EyeOff />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => triggerUpload("/")}
            disabled={uploading !== null}
            aria-label="Upload to /"
          >
            {uploading === "/" ? <Loader2 className="animate-spin" /> : <Upload />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setNewEntry({ kind: "folder", dir: "/" })}
            aria-label="New folder in /"
          >
            <FolderPlus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setNewEntry({ kind: "file", dir: "/" })}
            aria-label="New file in /"
          >
            <FilePlus />
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
                onClick={() => setNewEntry({ kind: "file", dir: "/" })}
              >
                <FilePlus />
                New file
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setNewEntry({ kind: "folder", dir: "/" })}
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

      <NewEntryDialog
        projectId={projectId}
        target={newEntry}
        onOpenChange={open => { if (!open) setNewEntry(null) }}
        onCreated={afterEntryCreated}
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

type EntryKind = "folder" | "file"

// NewEntryDialog creates a folder or an empty file in `target.dir`.
function NewEntryDialog({
  projectId,
  target,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  target: { kind: EntryKind; dir: string } | null
  onOpenChange: (open: boolean) => void
  onCreated: (kind: EntryKind, dir: string, path: string) => void | Promise<void>
}) {
  const dir = target?.dir ?? null
  const isFile = target?.kind === "file"
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setName("")
      setError(null)
    })
    return () => { cancelled = true }
  }, [target])

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed || busy || !dir) return
    setBusy(true)
    setError(null)
    try {
      const kind = isFile ? "file" : "folder"
      if (isFile) await fileActions.createFile(projectId, dir, trimmed)
      else await fileActions.createFolder(projectId, dir, trimmed)
      onOpenChange(false)
      await onCreated(kind, dir, joinPath(dir, trimmed))
    } catch (e) {
      setError(e instanceof Error ? e.message : `create ${isFile ? "file" : "folder"} failed`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={dir !== null}
      onOpenChange={o => {
        if (busy) return
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isFile ? "New file" : "New folder"}</DialogTitle>
          <DialogDescription>
            Create {isFile ? "a file" : "a folder"} in <span className="font-mono text-foreground">{dir ?? ""}</span>.
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
          placeholder={isFile ? "File name" : "Folder name"}
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
// NewEntryDialog's shape so the two stay visually consistent.
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
