"use client"

// FileBrowserPanel — lazy-loaded tree of /work inside the sandbox. Listing
// comes from the filemgr sidecar via the backend proxy. Folders expand/collapse
// in place (children fetched on first expand); clicking a file opens it in a
// large modal viewer (uses the existing FileViewer with shiki highlighting).
// Per-row hover actions: folders reveal rename/upload/delete (upload writes
// directly into that folder), files reveal rename/delete. Rename and new-folder
// both go through dialogs for consistency. Drag-drop onto a folder row uploads
// into that folder; drop on blank space uploads to root.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Loader2,
  Maximize2,
  Minimize2,
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
import { FileViewer } from "@/components/file-viewer"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/markdown"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { cn } from "@/lib/utils"
import {
  createFolder,
  deleteFile,
  downloadFileURL,
  rawFilePathURL,
  listFiles,
  rawFileURL,
  readFile,
  renameFile,
  uploadFile,
  type FileEntry,
  type FileReadResponse,
} from "@/lib/api"

const MIN_REFRESH_SPIN_MS = 1000

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
])
const HTML_EXTS = new Set(["html", "htm"])
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase())
}

function isHtmlPath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return HTML_EXTS.has(path.slice(dot + 1).toLowerCase())
}

function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return MARKDOWN_EXTS.has(path.slice(dot + 1).toLowerCase())
}

interface Props {
  projectId: string
}

// Opened file is either a text read result (already fetched into memory) or
// a marker that says "this is an image, render it via <img src={rawFileURL}>".
// Images skip /read entirely — the browser fetches bytes itself.
type OpenedFile =
  | { kind: "text"; path: string; data: FileReadResponse }
  | { kind: "image"; path: string }
  | { kind: "html"; path: string; data: FileReadResponse }
  | { kind: "markdown"; path: string; data: FileReadResponse }

type PreviewMode = "preview" | "source"

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

export function FileBrowserPanel({ projectId }: Props) {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<OpenedFile | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [newFolderDir, setNewFolderDir] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entry: FileEntry; path: string } | null>(null)
  const dragDepthRef = useRef(0)
  const uploadDirRef = useRef<string>("/")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths(prev => new Set(prev).add(path))
    setError(null)
    try {
      const list = await listFiles(projectId, path)
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
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadDir("/")
    })
    return () => { cancelled = true }
  }, [loadDir])

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
    if (isImagePath(path)) {
      setOpened({ kind: "image", path })
      return
    }
    setOpenLoading(true)
    try {
      const data = await readFile(projectId, path)
      if (isHtmlPath(path)) {
        setOpened({ kind: "html", path, data })
        return
      }
      if (isMarkdownPath(path)) {
        setOpened({ kind: "markdown", path, data })
        return
      }
      setOpened({ kind: "text", path, data })
    } catch (e) {
      const data = { path, size: 0, truncated: false, binary: false, content: `Error: ${e instanceof Error ? e.message : "unknown"}` }
      if (isHtmlPath(path)) {
        setOpened({ kind: "html", path, data })
        return
      }
      if (isMarkdownPath(path)) {
        setOpened({ kind: "markdown", path, data })
        return
      }
      setOpened({ kind: "text", path, data })
    } finally {
      setOpenLoading(false)
    }
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

  async function afterFolderCreated(dir: string) {
    setExpanded(prev => dir === "/" ? prev : new Set(prev).add(dir))
    await loadDir(dir)
  }

  async function refresh() {
    setRefreshing(true)
    const startedAt = Date.now()
    try {
      await Promise.all([
        loadDir("/"),
        ...Array.from(expanded)
          .filter(path => path !== "/")
          .map(path => loadDir(path)),
      ])
    } finally {
      const remaining = MIN_REFRESH_SPIN_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
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
    e.dataTransfer.dropEffect = "copy"
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
    const files = Array.from(e.dataTransfer.files)
    await uploadFiles("/", files)
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
      onClick: () => isDir ? toggleExpand(path) : void openFile(path),
      onFilesDropped: isDir ? files => uploadFiles(path, files) : undefined,
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
            onClick={() => setNewFolderDir("/")}
            title="New folder in /"
          >
            <FolderPlus />
          </Button>
        </div>
      </div>

      <div
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
        {!error && rootChildren && rootChildren.length > 0 && (
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

      <FileViewerDialog
        projectId={projectId}
        opened={opened}
        loading={openLoading}
        onClose={() => setOpened(null)}
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

// FileViewerDialog — large modal for reading a single file. Uses a flex
// column inside DialogContent so the body scrolls but the header stays
// pinned. The default DialogContent caps width at sm:max-w-sm — way too
// small for code; bump to ~5xl and let it stretch tall.
function FileViewerDialog({
  projectId,
  opened,
  loading,
  onClose,
}: {
  projectId: string
  opened: OpenedFile | null
  loading: boolean
  onClose: () => void
}) {
  const [fullscreen, setFullscreen] = useState(false)
  const [modeByPath, setModeByPath] = useState<{ path: string | null; mode: PreviewMode }>({
    path: null,
    mode: "preview",
  })

  const canToggleMode = opened?.kind === "html" || opened?.kind === "markdown"
  const mode = canToggleMode && modeByPath.path === opened.path ? modeByPath.mode : "preview"
  const close = () => {
    setFullscreen(false)
    onClose()
  }

  return (
    <Dialog open={opened !== null} onOpenChange={open => { if (!open) close() }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          opened && "file-preview-dialog",
          "w-[calc(100%-2rem)] sm:max-w-5xl h-[80vh] p-0 gap-0 flex flex-col overflow-hidden",
          fullscreen && "top-0 left-0 !h-dvh !w-screen !max-w-none translate-x-0 translate-y-0 rounded-none sm:!max-w-none"
        )}
      >
        {opened && (
          <>
            <DialogTitle className="sr-only">{opened.path}</DialogTitle>
            <div className="flex items-center gap-2 px-3 h-12 border-b shrink-0">
              <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-mono truncate flex-1" title={opened.path}>
                {opened.path}
              </span>
              {(opened.kind === "text" || opened.kind === "html" || opened.kind === "markdown") && opened.data.truncated && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
                  truncated
                </span>
              )}
              {canToggleMode && (
                <div className="flex h-7 shrink-0 items-center rounded border bg-muted/30 p-0.5">
                  <button
                    type="button"
                    onClick={() => setModeByPath({ path: opened.path, mode: "preview" })}
                    className={cn(
                      "h-6 px-2 text-[11px] rounded cursor-pointer",
                      mode === "preview" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setModeByPath({ path: opened.path, mode: "source" })}
                    className={cn(
                      "h-6 px-2 text-[11px] rounded cursor-pointer",
                      mode === "source" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Source
                  </button>
                </div>
              )}
              <a
                href={downloadFileURL(projectId, opened.path)}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted"
                title="Download"
              >
                <Download className="size-3.5" />
              </a>
              <button
                type="button"
                onClick={() => setFullscreen(value => !value)}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted cursor-pointer"
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={close}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted text-xs cursor-pointer"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="file-preview-scroll flex-1 min-h-0 overflow-auto">
              {opened.kind === "image" ? (
                <div className="flex h-full items-center justify-center p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={rawFileURL(projectId, opened.path)}
                    alt={opened.path}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : opened.kind === "html" && mode === "preview" ? (
                <iframe
                  src={rawFilePathURL(projectId, opened.path)}
                  title={opened.path}
                  sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  className="h-full w-full border-0 bg-white"
                />
              ) : opened.kind === "markdown" && mode === "preview" ? (
                <div className="mx-auto w-full max-w-4xl p-6">
                  <Markdown className="text-foreground">
                    {opened.data.content ?? ""}
                  </Markdown>
                </div>
              ) : loading ? (
                <div className="p-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
              ) : opened.data.binary ? (
                <div className="p-6 text-muted-foreground italic">
                  Binary file ({opened.data.size} bytes). Use download to fetch it.
                </div>
              ) : (
                <FileViewer
                  path={opened.path}
                  lines={(opened.data.content ?? "").split("\n").map((text, i) => ({ n: i + 1, text }))}
                />
              )}
            </div>
          </>
        )}
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
