"use client"

// FileBrowserPanel — read-only directory tree of /work inside the sandbox.
// Listing comes from the filemgr sidecar via the backend proxy. Clicking a
// directory navigates in; clicking a file opens it in a large modal viewer
// (uses the existing FileViewer with shiki highlighting). Toolbar has "up"
// (parent dir), refresh, upload; each file row reveals a download icon on
// hover.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { FileViewer } from "@/components/file-viewer"
import { Markdown } from "@/components/markdown"
import { cn } from "@/lib/utils"
import {
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
  canWrite: boolean
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

export function FileBrowserPanel({ projectId, canWrite }: Props) {
  const [dir, setDir] = useState("/")
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [opened, setOpened] = useState<OpenedFile | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)
  const dragDepthRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const list = await listFiles(projectId, path)
      setEntries(list)
    } catch (e) {
      setEntries(null)
      setError(e instanceof Error ? e.message : "failed to load")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      load(dir)
    })
    return () => { cancelled = true }
  }, [dir, load])

  function goInto(name: string) {
    const next = dir === "/" ? `/${name}` : `${dir}/${name}`
    setDir(next)
    setOpened(null)
  }

  function goUp() {
    if (dir === "/") return
    const parts = dir.split("/").filter(Boolean)
    parts.pop()
    setDir(parts.length === 0 ? "/" : "/" + parts.join("/"))
    setOpened(null)
  }

  async function openFile(name: string) {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`
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

  async function uploadFiles(files: File[]) {
    if (!canWrite || files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) {
        await uploadFile(projectId, dir, file)
      }
      await load(dir)
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(false)
    }
  }

  async function commitRename(entry: FileEntry, nextName: string): Promise<boolean> {
    const trimmed = nextName.trim()
    if (!trimmed || trimmed === entry.name) return false
    const from = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`
    try {
      await renameFile(projectId, from, trimmed)
      await load(dir)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename failed")
      return false
    }
  }

  async function confirmDelete(entry: FileEntry) {
    const target = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`
    await deleteFile(projectId, target)
    await load(dir)
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = "" // allow re-selecting the same file later
    await uploadFiles(files)
  }

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!canWrite) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!canWrite) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!canWrite) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!canWrite) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    await uploadFiles(files)
  }

  // Breadcrumb segments — clicking a segment jumps directly there
  const segments = dir === "/" ? [] : dir.split("/").filter(Boolean)

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Files
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={goUp}
          disabled={dir === "/"}
          title="Up"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={() => load(dir)}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <button
            onClick={() => { setDir("/"); setOpened(null) }}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            /
          </button>
          {segments.map((seg, i) => {
            const target = "/" + segments.slice(0, i + 1).join("/")
            return (
              <span key={target} className="flex items-center gap-0.5">
                <ChevronRight className="size-3 text-muted-foreground/50" />
                <button
                  onClick={() => { setDir(target); setOpened(null) }}
                  className="text-muted-foreground hover:text-foreground truncate cursor-pointer"
                  title={target}
                >
                  {seg}
                </button>
              </span>
            )
          })}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onUpload}
        />
        {canWrite && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Upload to this folder"
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          </Button>
        )}
      </div>

      <div
        className={cn(
          "relative flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5 transition-colors",
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
        {!error && entries === null && loading && (
          <div className="flex min-h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        )}
        {!error && entries && entries.length === 0 && (
          <div className="flex min-h-full flex-col items-center justify-center gap-2 px-4 py-10 text-muted-foreground">
            <Folder className="size-5 opacity-70" />
            <span>No files</span>
          </div>
        )}
        {entries && entries.map(entry => (
          <FileRow
            key={entry.name}
            entry={entry}
            dir={dir}
            projectId={projectId}
            canWrite={canWrite}
            onOpenFile={openFile}
            onEnterDir={goInto}
            onRename={nextName => commitRename(entry, nextName)}
            onRequestDelete={() => setDeleteTarget(entry)}
          />
        ))}
      </div>

      <FileViewerDialog
        projectId={projectId}
        opened={opened}
        loading={openLoading}
        onClose={() => setOpened(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={open => { if (!open) setDeleteTarget(null) }}
        title={deleteTarget?.type === "dir" ? "Delete folder?" : "Delete file?"}
        description={
          <>
            {deleteTarget?.type === "dir"
              ? "Recursively delete "
              : "Delete "}
            <span className="font-mono text-foreground">{deleteTarget?.name}</span>
            ? This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (deleteTarget) await confirmDelete(deleteTarget)
        }}
      />
    </div>
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

function FileRow({
  entry,
  dir,
  projectId,
  canWrite,
  onOpenFile,
  onEnterDir,
  onRename,
  onRequestDelete,
}: {
  entry: FileEntry
  dir: string
  projectId: string
  canWrite: boolean
  onOpenFile: (name: string) => void
  onEnterDir: (name: string) => void
  onRename: (nextName: string) => Promise<boolean>
  onRequestDelete: () => void
}) {
  const isDir = entry.type === "dir"
  const fullPath = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.name)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(entry.name)
    setEditing(true)
  }

  async function commit() {
    if (busy) return
    setBusy(true)
    try {
      const ok = await onRename(draft)
      // On success the parent reloads the list and this row unmounts; either
      // way close the editor.
      setEditing(false)
      return ok
    } finally {
      setBusy(false)
    }
  }

  function cancel() {
    setDraft(entry.name)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-2 h-6 bg-muted/40">
        {isDir
          ? <Folder className="size-3.5 text-muted-foreground shrink-0" />
          : <FileIcon className="size-3.5 text-muted-foreground/70 shrink-0" />}
        <input
          ref={inputRef}
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); void commit() }
            else if (e.key === "Escape") { e.preventDefault(); cancel() }
          }}
          className="flex-1 min-w-0 h-5 rounded border bg-background px-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          onClick={e => { e.stopPropagation(); void commit() }}
          disabled={busy}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Save"
          aria-label="Save rename"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
        </button>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); cancel() }}
          disabled={busy}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Cancel"
          aria-label="Cancel rename"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div
      onClick={() => isDir ? onEnterDir(entry.name) : onOpenFile(entry.name)}
      className="group flex items-center gap-1.5 px-2 h-6 cursor-pointer hover:bg-muted/60"
    >
      {isDir
        ? <Folder className="size-3.5 text-muted-foreground shrink-0" />
        : <FileIcon className="size-3.5 text-muted-foreground/70 shrink-0" />}
      <span className="truncate flex-1">{entry.name}</span>
      {!isDir && (
        <span className="hidden sm:inline text-[10px] text-muted-foreground/60 shrink-0 group-hover:hidden">
          {formatSize(entry.size)}
        </span>
      )}
      {!isDir && (
        <a
          href={downloadFileURL(projectId, fullPath)}
          onClick={e => e.stopPropagation()}
          className="hidden group-hover:inline-flex text-muted-foreground hover:text-foreground shrink-0"
          title="Download"
        >
          <Download className="size-3" />
        </a>
      )}
      {canWrite && (
        <>
          <button
            type="button"
            onClick={startEdit}
            className="hidden group-hover:inline-flex text-muted-foreground hover:text-foreground shrink-0"
            title="Rename"
            aria-label="Rename"
          >
            <Pencil className="size-3" />
          </button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onRequestDelete() }}
            className="hidden group-hover:inline-flex text-muted-foreground hover:text-destructive shrink-0"
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        </>
      )}
    </div>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}
