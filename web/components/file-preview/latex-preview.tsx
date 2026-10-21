"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { latexPreview, rawFileURL, type LatexPreviewState } from "@/lib/api"
import { cn } from "@/lib/utils"
import { pdfViewerURL } from "./pdf-preview"
import { TextPreview } from "./text-preview"
import type { FilePreviewProps } from "./types"

export function LatexPreview({ projectId, path, content }: FilePreviewProps) {
  const [state, setState] = useState<LatexPreviewState | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const compiling = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    async function refresh() {
      if (compiling.current || document.visibilityState === "hidden") return
      try {
        const next = await latexPreview(projectId, path)
        if (!cancelled && !compiling.current) setState(next)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unable to check preview")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30000)
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      mounted.current = false
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
    }
  }, [projectId, path])

  async function compile() {
    if (compiling.current) return
    compiling.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await latexPreview(projectId, path, true)
      if (mounted.current) setState(next)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Compilation failed")
    } finally {
      compiling.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const pdfURL = state?.pdf ? `${rawFileURL(projectId, state.pdf)}&v=${encodeURIComponent(state.version ?? "")}` : null
  const status = busy ? "Compiling…" : loading ? "Checking…" : state?.pdf
    ? state.stale ? "Out of date" : "Up to date"
    : "No preview yet"
  const needsCompile = !state?.pdf || state.stale
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <pre role="alert" className="max-h-48 shrink-0 overflow-auto whitespace-pre-wrap border-b p-3 text-xs text-destructive">{error}</pre>}
      <div className="relative min-h-0 flex-1">
        {pdfURL
          ? <iframe src={pdfViewerURL(pdfURL)} title={`${path} PDF preview`} className="h-full w-full border-0 bg-muted" />
          : <div className="h-full overflow-auto"><TextPreview path={path} content={content} /></div>}
        {/* Floating instead of a bar, so the PDF keeps the whole pane. */}
        <div className="absolute right-5 bottom-4 flex items-center gap-2 rounded-lg border bg-background/90 py-1 pr-1 pl-2.5 text-xs shadow-md backdrop-blur">
          <span
            className={cn("flex items-center gap-1.5", needsCompile && !busy && !loading ? "text-amber-500" : "text-muted-foreground")}
            role="status"
          >
            {(busy || loading) && <Loader2 className="size-3 animate-spin" />}
            {status}
          </span>
          <Button
            size="sm"
            variant={needsCompile ? "default" : "outline"}
            disabled={busy || loading}
            onClick={() => void compile()}
          >
            {state?.pdf ? state.stale ? "Update" : "Recompile" : "Compile"}
          </Button>
        </div>
      </div>
    </div>
  )
}
