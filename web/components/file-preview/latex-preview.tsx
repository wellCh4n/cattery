"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { latexPreview, rawFileURL, type LatexPreviewState } from "@/lib/api"
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
        <span className="text-muted-foreground" role="status">
          {busy ? "Compiling preview…" : loading ? "Checking preview…" : state?.pdf
            ? state.stale ? "Preview needs updating" : "Preview is up to date"
            : "No PDF preview yet. Compile to preview this document."}
        </span>
        <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void compile()}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {state?.pdf ? "Update preview" : "Compile preview"}
        </Button>
      </div>
      {error && <pre role="alert" className="max-h-48 shrink-0 overflow-auto whitespace-pre-wrap border-b p-3 text-xs text-destructive">{error}</pre>}
      {pdfURL
        ? <iframe src={pdfURL} title={`${path} PDF preview`} className="min-h-0 flex-1 w-full border-0 bg-muted" />
        : <div className="min-h-0 flex-1 overflow-auto"><TextPreview path={path} content={content} /></div>}
    </div>
  )
}
