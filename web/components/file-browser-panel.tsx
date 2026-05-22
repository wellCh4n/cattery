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
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { FileViewer } from "@/components/file-viewer"
import { cn } from "@/lib/utils"
import {
  downloadFileURL,
  listFiles,
  rawFileURL,
  readFile,
  uploadFile,
  type FileEntry,
  type FileReadResponse,
  type Harness,
} from "@/lib/api"

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase())
}

interface Props {
  harness: Harness
}

// Opened file is either a text read result (already fetched into memory) or
// a marker that says "this is an image, render it via <img src={rawFileURL}>".
// Images skip /read entirely — the browser fetches bytes itself.
type OpenedFile =
  | { kind: "text"; path: string; data: FileReadResponse }
  | { kind: "image"; path: string }

export function FileBrowserPanel({ harness }: Props) {
  const [dir, setDir] = useState("/")
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [opened, setOpened] = useState<OpenedFile | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ready = harness.sandbox_status === "ready"

  const load = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const list = await listFiles(harness.harness_id, path)
      setEntries(list)
    } catch (e) {
      setEntries(null)
      setError(e instanceof Error ? e.message : "failed to load")
    } finally {
      setLoading(false)
    }
  }, [harness.harness_id])

  useEffect(() => {
    if (!ready) {
      setEntries(null)
      return
    }
    load(dir)
  }, [ready, dir, load])

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
    // Images skip /read — the dialog renders an <img> straight against /raw.
    // That avoids pulling the binary bytes into JS just to throw them away.
    if (isImagePath(path)) {
      setOpened({ kind: "image", path })
      return
    }
    setOpenLoading(true)
    try {
      const data = await readFile(harness.harness_id, path)
      setOpened({ kind: "text", path, data })
    } catch (e) {
      setOpened({
        kind: "text",
        path,
        data: { path, size: 0, truncated: false, binary: false, content: `Error: ${e instanceof Error ? e.message : "unknown"}` },
      })
    } finally {
      setOpenLoading(false)
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-selecting the same file later
    if (!file) return
    setUploading(true)
    try {
      await uploadFile(harness.harness_id, dir, file)
      await load(dir)
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(false)
    }
  }

  // Breadcrumb segments — clicking a segment jumps directly there
  const segments = dir === "/" ? [] : dir.split("/").filter(Boolean)

  return (
    <div className="flex h-full flex-col text-xs">
      <header className="flex items-center gap-1 px-2 h-12 border-b shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={goUp}
          disabled={dir === "/" || !ready}
          title="Up"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => load(dir)}
          disabled={!ready || loading}
          title="Refresh"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto pl-1">
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
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={!ready || uploading}
          title="Upload to this folder"
        >
          {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!ready && (
          <div className="p-4 text-muted-foreground">Sandbox is not ready yet.</div>
        )}
        {ready && error && (
          <div className="p-4 text-destructive">{error}</div>
        )}
        {ready && !error && entries && entries.length === 0 && (
          <div className="p-4 text-muted-foreground italic">(empty)</div>
        )}
        {ready && entries && entries.map(entry => (
          <FileRow
            key={entry.name}
            entry={entry}
            dir={dir}
            harnessId={harness.harness_id}
            onOpenFile={openFile}
            onEnterDir={goInto}
          />
        ))}
      </div>

      <FileViewerDialog
        harnessId={harness.harness_id}
        opened={opened}
        loading={openLoading}
        onClose={() => setOpened(null)}
      />
    </div>
  )
}

// FileViewerDialog — large modal for reading a single file. Uses a flex
// column inside DialogContent so the body scrolls but the header stays
// pinned. The default DialogContent caps width at sm:max-w-sm — way too
// small for code; bump to ~5xl and let it stretch tall.
function FileViewerDialog({
  harnessId,
  opened,
  loading,
  onClose,
}: {
  harnessId: string
  opened: OpenedFile | null
  loading: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={opened !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100%-2rem)] sm:max-w-5xl h-[80vh] p-0 gap-0 flex flex-col overflow-hidden"
      >
        {opened && (
          <>
            <DialogTitle className="sr-only">{opened.path}</DialogTitle>
            <div className="flex items-center gap-2 px-3 h-12 border-b shrink-0">
              <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-mono truncate flex-1" title={opened.path}>
                {opened.path}
              </span>
              {opened.kind === "text" && opened.data.truncated && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
                  truncated
                </span>
              )}
              <a
                href={downloadFileURL(harnessId, opened.path)}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted"
                title="Download"
              >
                <Download className="size-3.5" />
              </a>
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted text-xs cursor-pointer"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {opened.kind === "image" ? (
                <div className="flex h-full items-center justify-center p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={rawFileURL(harnessId, opened.path)}
                    alt={opened.path}
                    className="max-w-full max-h-full object-contain"
                  />
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
  harnessId,
  onOpenFile,
  onEnterDir,
}: {
  entry: FileEntry
  dir: string
  harnessId: string
  onOpenFile: (name: string) => void
  onEnterDir: (name: string) => void
}) {
  const isDir = entry.type === "dir"
  const fullPath = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`
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
        <>
          <span className="hidden sm:inline text-[10px] text-muted-foreground/60 shrink-0 group-hover:hidden">
            {formatSize(entry.size)}
          </span>
          <a
            href={downloadFileURL(harnessId, fullPath)}
            onClick={e => e.stopPropagation()}
            className="hidden group-hover:inline-flex text-muted-foreground hover:text-foreground shrink-0"
            title="Download"
          >
            <Download className="size-3" />
          </a>
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
