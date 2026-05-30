"use client"

// FileView — renders a single project file filling its container: a thin header
// (path + truncation badge + preview/source toggle + download) over a scrolling
// body. The body picks a renderer from the file extension: images via <img>,
// PDFs/HTML via <iframe> (served raw by the backend), markdown via Markdown (or
// raw source), everything else through the shiki-highlighted FileViewer. This
// is the main-pane counterpart to the file browser's old modal preview.

import { useEffect, useState } from "react"
import { Download, File as FileIcon, Loader2 } from "lucide-react"
import { FileViewer } from "@/components/file-viewer"
import { Markdown } from "@/components/markdown"
import { cn } from "@/lib/utils"
import {
  downloadFileURL,
  rawFileURL,
  rawFilePathURL,
  readFile,
  type FileReadResponse,
} from "@/lib/api"

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
])
const HTML_EXTS = new Set(["html", "htm"])
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"])

type FileKind = "text" | "image" | "pdf" | "html" | "markdown"
type PreviewMode = "preview" | "source"

function extOf(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase()
}

function kindForPath(path: string): FileKind {
  const ext = extOf(path)
  if (IMAGE_EXTS.has(ext)) return "image"
  if (ext === "pdf") return "pdf"
  if (HTML_EXTS.has(ext)) return "html"
  if (MARKDOWN_EXTS.has(ext)) return "markdown"
  return "text"
}

export function FileView({ projectId, path }: { projectId: string; path: string }) {
  const kind = kindForPath(path)
  // Only text-like files are fetched into memory; images/pdfs are streamed by
  // the browser straight from the raw endpoints.
  const needsRead = kind === "text" || kind === "html" || kind === "markdown"
  const [data, setData] = useState<FileReadResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(() => needsRead)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<PreviewMode>("preview")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setMode("preview")
      if (!needsRead) {
        setData(null)
        setError(null)
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const d = await readFile(projectId, path)
        if (!cancelled) setData(d)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to open")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [projectId, path, needsRead])

  const canToggle = kind === "html" || kind === "markdown"
  const showSource = canToggle && mode === "source"

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={path}>
          {path}
        </span>
        {data?.truncated && (
          <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">truncated</span>
        )}
        {canToggle && (
          <div className="flex h-6 shrink-0 items-center rounded border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={cn(
                "h-5 cursor-pointer rounded px-1.5 text-[10px]",
                mode === "preview" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setMode("source")}
              className={cn(
                "h-5 cursor-pointer rounded px-1.5 text-[10px]",
                mode === "source" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Source
            </button>
          </div>
        )}
        <a
          href={downloadFileURL(projectId, path)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Download"
          aria-label="Download"
        >
          <Download className="size-3.5" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {kind === "image" ? (
          <div className="flex h-full items-center justify-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={rawFileURL(projectId, path)} alt={path} className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "pdf" ? (
          <iframe src={rawFilePathURL(projectId, path)} title={path} className="h-full w-full border-0 bg-muted" />
        ) : kind === "html" && !showSource ? (
          <iframe
            src={rawFilePathURL(projectId, path)}
            title={path}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            className="h-full w-full border-0 bg-white"
          />
        ) : loading ? (
          <div className="p-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        ) : error ? (
          <p className="p-4 text-destructive">{error}</p>
        ) : data?.binary ? (
          <p className="p-6 italic text-muted-foreground">
            Binary file ({data.size} bytes). Use download to fetch it.
          </p>
        ) : kind === "markdown" && !showSource ? (
          <div className="mx-auto w-full max-w-4xl p-6">
            <Markdown className="text-foreground">{data?.content ?? ""}</Markdown>
          </div>
        ) : (
          <FileViewer
            path={path}
            lines={(data?.content ?? "").split("\n").map((text, i) => ({ n: i + 1, text }))}
          />
        )}
      </div>
    </div>
  )
}
