"use client"

// SkillView — renders one skill filling its container: a header (skill name)
// over a two-pane body. Left is the skill's file tree (lazy-listed via the
// skillmgr list endpoint); right previews the selected file — SKILL.md and
// other markdown render through Markdown (with a source toggle), everything
// else through the shiki-highlighted FileViewer. This is the main-pane
// counterpart to the skill browser's old modal.

import { useCallback, useEffect, useState } from "react"
import { File as FileIcon, Folder, Loader2, Puzzle } from "lucide-react"
import { FileViewer } from "@/components/file-viewer"
import { Markdown } from "@/components/markdown"
import { Tree, type TreeNode } from "@/components/tree"
import { cn } from "@/lib/utils"
import { listSkills, readSkillFile, type FileEntry, type FileReadResponse } from "@/lib/api"

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"])

type PreviewMode = "preview" | "source"

function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return MARKDOWN_EXTS.has(path.slice(dot + 1).toLowerCase())
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    // SKILL.md is the manifest — always pin it to the top, ahead of folders.
    const aManifest = a.name === "SKILL.md"
    const bManifest = b.name === "SKILL.md"
    if (aManifest !== bManifest) return aManifest ? -1 : 1
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function SkillView({ slug, name }: { slug: string; name: string }) {
  const base = `/${slug}`
  const manifestPath = `${base}/SKILL.md`
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string>(manifestPath)
  const [mode, setMode] = useState<PreviewMode>("preview")
  const [data, setData] = useState<FileReadResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The skill's file tree is secondary to the preview, so listing failures are
  // swallowed rather than surfaced over the SKILL.md content.
  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths(prev => new Set(prev).add(path))
    try {
      const list = await listSkills(path)
      setChildrenByPath(prev => ({ ...prev, [path]: sortEntries(list) }))
    } catch { /* ignore */ } finally {
      setLoadingPaths(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) void loadDir(base) })
    return () => { cancelled = true }
  }, [base, loadDir])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const d = await readSkillFile(selected)
        if (!cancelled) setData(d)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to open")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selected])

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

  function buildNode(entry: FileEntry, path: string): TreeNode {
    const isDir = entry.type === "dir"
    const isOpen = expanded.has(path)
    const childEntries = isDir && isOpen ? childrenByPath[path] : undefined
    return {
      id: path,
      expandable: isDir,
      expanded: isOpen,
      loadingChildren: isDir && isOpen && loadingPaths.has(path) && !childEntries,
      children: childEntries
        ? childEntries.map(child => buildNode(child, joinPath(path, child.name)))
        : isDir && isOpen
          ? []
          : undefined,
      selected: !isDir && selected === path,
      body: (
        <>
          {isDir
            ? <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            : <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </>
      ),
      onClick: () => {
        if (isDir) {
          toggleExpand(path)
        } else {
          setSelected(path)
          setMode("preview")
        }
      },
    }
  }

  const isMd = isMarkdownPath(selected)
  const showMarkdown = isMd && mode === "preview"
  const rootChildren = childrenByPath[base]

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="flex w-44 shrink-0 flex-col overflow-hidden rounded border">
          <div className="flex h-9 shrink-0 items-center border-b px-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-foreground/70">
              SKILL
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!rootChildren && (
              <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading…
              </div>
            )}
            {rootChildren && (
              <Tree items={rootChildren.map(entry => buildNode(entry, joinPath(base, entry.name)))} />
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={selected}>
              {selected}
            </span>
            {data?.truncated && (
              <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">truncated</span>
            )}
            {isMd && (
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
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && <div className="p-3"><Loader2 className="size-4 animate-spin" /></div>}
            {error && <p className="p-3 text-destructive">{error}</p>}
            {!loading && !error && data?.binary && (
              <p className="p-3 italic text-muted-foreground">Binary file ({data.size} bytes) — preview not supported.</p>
            )}
            {!loading && !error && data && !data.binary && showMarkdown && (
              <div className="p-3"><Markdown className="text-foreground">{data.content ?? ""}</Markdown></div>
            )}
            {!loading && !error && data && !data.binary && !showMarkdown && (
              <FileViewer
                path={selected}
                lines={(data.content ?? "").split("\n").map((text, i) => ({ n: i + 1, text }))}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
