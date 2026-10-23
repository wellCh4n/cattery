"use client"

// Shared file shell: loading, header and source mode. Format-specific
// rendering and capabilities live in the file-preview registry. The source
// view is an editor; unsaved text also feeds content-based previews.

import { useEffect, useState } from "react"
import { Download, File as FileIcon, Loader2 } from "lucide-react"
import { previewForPath, textPreview } from "@/components/file-preview/registry"
import { FileEditor } from "@/components/file-editor"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  downloadFileURL,
  FileConflictError,
  rawFileURL,
  rawFilePathURL,
  readFile,
  saveFile,
  type FileReadResponse,
} from "@/lib/api"

type PreviewMode = "preview" | "source"

interface Draft {
  content: string
  mtime: string // of the file the draft started from
}

// Unsaved edits, keyed by project and path, so switching tabs (which
// unmounts the view) keeps them. A reload drops them; beforeunload warns.
const drafts = new Map<string, Draft>()

export function FileView({ projectId, path }: { projectId: string; path: string }) {
  const preview = previewForPath(path)
  const draftKey = `${projectId}:${path}`
  // Prefetch source for formats with a toggle, including URL-based previews.
  const needsRead = preview.input === "content" || preview.supportsSource
  const [data, setData] = useState<FileReadResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(() => needsRead)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<PreviewMode>("preview")
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(draftKey) ?? null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null)

  const dirty = draft !== null && draft.content !== data?.content
  const canEdit = !!data && !data.binary && !data.truncated

  function setDraft(next: Draft | null) {
    if (next) drafts.set(draftKey, next)
    else drafts.delete(draftKey)
    setDraftState(next)
  }

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

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  function edit(content: string) {
    if (!data) return
    setDraft({ content, mtime: draft?.mtime ?? data.mtime })
  }

  function revert() {
    if (!window.confirm("Discard unsaved changes?")) return
    setSaveError(null)
    setDraft(null)
  }

  // Saves the draft; `overwrite` skips the changed-on-disk check.
  async function save(overwrite = false) {
    if (!draft || !dirty || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveFile(projectId, path, draft.content, overwrite ? undefined : draft.mtime)
      setData(d => d && { ...d, content: draft.content, size: saved.size, mtime: saved.mtime })
      setDraft(null)
    } catch (e) {
      setSaveError({
        message: e instanceof Error ? e.message : "save failed",
        conflict: e instanceof FileConflictError,
      })
    } finally {
      setSaving(false)
    }
  }

  // Drops the draft and loads what is on disk now.
  async function reload() {
    setSaveError(null)
    setDraft(null)
    setLoading(true)
    try {
      setData(await readFile(projectId, path))
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to open")
    } finally {
      setLoading(false)
    }
  }

  const canToggle = preview.supportsSource
  const renderer = canToggle && mode === "source" ? textPreview : preview
  const Preview = renderer.component
  const content = draft?.content ?? data?.content ?? ""
  const previewProps = {
    projectId,
    path,
    content,
    truncated: data?.truncated ?? false,
    rawURL: rawFileURL(projectId, path),
    rawPathURL: rawFilePathURL(projectId, path),
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={path}>
          {path}
          {dirty && <span className="ml-1 text-foreground">●</span>}
        </span>
        {data?.truncated && (
          <span className="shrink-0 text-2xs text-amber-600 dark:text-amber-400">truncated</span>
        )}
        {canToggle && (
          <div className="flex h-6 shrink-0 items-center rounded-md border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={cn(
                "h-5 cursor-pointer rounded-sm px-1.5 text-2xs",
                mode === "preview" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setMode("source")}
              className={cn(
                "h-5 cursor-pointer rounded-sm px-1.5 text-2xs",
                mode === "source" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Source
            </button>
          </div>
        )}
        {dirty && (
          <>
            <Button variant="ghost" size="xs" onClick={revert} disabled={saving}>
              Revert
            </Button>
            <Button size="xs" onClick={() => void save()} disabled={saving} title="Save (⌘S)">
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </>
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

      {saveError && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-destructive">
          <span className="min-w-0 flex-1 truncate">
            {saveError.conflict ? "This file changed since you opened it." : saveError.message}
          </span>
          {saveError.conflict && (
            <>
              <Button variant="ghost" size="xs" onClick={() => void reload()} disabled={saving}>
                Discard and reload
              </Button>
              <Button variant="destructive" size="xs" onClick={() => void save(true)} disabled={saving}>
                Overwrite
              </Button>
            </>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {renderer === textPreview && !loading && canEdit ? (
          <FileEditor path={path} value={content} onChange={edit} onSave={() => void save()} />
        ) : renderer.input === "url" ? (
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
