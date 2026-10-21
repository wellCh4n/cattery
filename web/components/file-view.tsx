"use client"

// Shared file shell: loading, header and source mode. Format-specific
// rendering and capabilities live in the file-preview registry.

import { useEffect, useState } from "react"
import { Download, File as FileIcon, Loader2 } from "lucide-react"
import { previewForPath, textPreview } from "@/components/file-preview/registry"
import { cn } from "@/lib/utils"
import {
  downloadFileURL,
  rawFileURL,
  rawFilePathURL,
  readFile,
  type FileReadResponse,
} from "@/lib/api"

type PreviewMode = "preview" | "source"

export function FileView({ projectId, path }: { projectId: string; path: string }) {
  const preview = previewForPath(path)
  // Prefetch source for formats with a toggle, including URL-based previews.
  const needsRead = preview.input === "content" || preview.supportsSource
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

  const canToggle = preview.supportsSource
  const renderer = canToggle && mode === "source" ? textPreview : preview
  const Preview = renderer.component
  const previewProps = {
    projectId,
    path,
    content: data?.content ?? "",
    truncated: data?.truncated ?? false,
    rawURL: rawFileURL(projectId, path),
    rawPathURL: rawFilePathURL(projectId, path),
  }

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
          <div className="flex h-6 shrink-0 items-center rounded-md border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={cn(
                "h-5 cursor-pointer rounded-sm px-1.5 text-[10px]",
                mode === "preview" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setMode("source")}
              className={cn(
                "h-5 cursor-pointer rounded-sm px-1.5 text-[10px]",
                mode === "source" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Source
            </button>
          </div>
        )}
        <a
          href={downloadFileURL(projectId, path)}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Download"
          aria-label="Download"
        >
          <Download className="size-3.5" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {renderer.input === "url" ? (
          <Preview key={`${projectId}:${path}`} {...previewProps} />
        ) : loading ? (
          <div className="p-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        ) : error ? (
          <p className="p-4 text-destructive">{error}</p>
        ) : data?.binary ? (
          <p className="p-6 italic text-muted-foreground">
            Binary file ({data.size} bytes). Use download to fetch it.
          </p>
        ) : (
          <Preview key={`${projectId}:${path}`} {...previewProps} />
        )}
      </div>
    </div>
  )
}
