"use client"

// SkillBrowserPanel — global skill library, rendered at the altitude of a
// *library* rather than a file tree: one row per skill (a top-level `<slug>/`
// folder), showing the name + description parsed from its SKILL.md frontmatter,
// backed by /api/v1/skills/catalog. Operations are skill-grained — upload a
// .zip (= add a skill), delete a skill, click to inspect its SKILL.md + assets.
// Stray top-level files or folders missing a SKILL.md are surfaced as invalid
// rows so they can be found and removed, instead of masquerading as skills.
//
// The raw per-file tree the skillmgr still exposes (list/read) is reused only
// inside the detail dialog to browse one skill's contents.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  File as FileIcon,
  Folder,
  Loader2,
  Puzzle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Markdown } from "@/components/markdown"
import { FileViewer } from "@/components/file-viewer"
import { Tree, type TreeNode } from "@/components/tree"
import { cn } from "@/lib/utils"
import {
  deleteSkillFile,
  listSkillCatalog,
  listSkills,
  readSkillFile,
  uploadSkillZip,
  type FileEntry,
  type FileReadResponse,
  type SkillCatalogItem,
} from "@/lib/api"

const MIN_REFRESH_SPIN_MS = 1000

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

export function SkillBrowserPanel() {
  const [catalog, setCatalog] = useState<SkillCatalogItem[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<SkillCatalogItem | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillCatalogItem | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setCatalog(await listSkillCatalog())
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load")
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void load()
    })
    return () => { cancelled = true }
  }, [load])

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    const start = Date.now()
    try {
      await load()
    } finally {
      const elapsed = Date.now() - start
      if (elapsed < MIN_REFRESH_SPIN_MS) {
        await new Promise(r => setTimeout(r, MIN_REFRESH_SPIN_MS - elapsed))
      }
      setRefreshing(false)
    }
  }

  async function onPickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ""
    if (!file) return
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Skill upload accepts a .zip archive only.")
      return
    }
    setUploading(true)
    setError(null)
    try {
      // Upload to root: a skill zip is a `<slug>/SKILL.md (+assets)` folder.
      await uploadSkillZip("/", file)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(false)
    }
  }

  async function confirmDelete(target: SkillCatalogItem) {
    try {
      await deleteSkillFile(`/${target.slug}`)
      if (opened?.slug === target.slug) setOpened(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed")
    }
  }

  const isEmpty = catalog !== null && catalog.length === 0

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Skills
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Upload skill .zip"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".zip,application/zip" hidden onChange={onPickerChange} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && (
          <div className="px-3 py-2 text-xs text-destructive">{error}</div>
        )}
        {catalog === null && !error && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </div>
        )}
        {isEmpty && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Puzzle className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">No skills</p>
            <div className="mt-3 flex w-32 flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                Upload
              </Button>
            </div>
          </div>
        )}
        {catalog?.map(skill => (
          <SkillRow
            key={skill.slug}
            skill={skill}
            onOpen={() => { if (skill.valid) setOpened(skill) }}
            onDelete={() => setDeleteTarget(skill)}
          />
        ))}
        {uploading && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Extracting skill…
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => { if (!open) setDeleteTarget(null) }}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete?"}
        description="This removes the skill and all its files from the global library. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteTarget) void confirmDelete(deleteTarget)
          setDeleteTarget(null)
        }}
      />

      <SkillDetailDialog skill={opened} onClose={() => setOpened(null)} />
    </div>
  )
}

function SkillRow({
  skill,
  onOpen,
  onDelete,
}: {
  skill: SkillCatalogItem
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={
        "group flex items-start gap-2 border-b px-3 py-2" +
        (skill.valid ? " cursor-pointer hover:bg-accent/50" : " bg-destructive/5")
      }
      onClick={skill.valid ? onOpen : undefined}
    >
      {skill.valid
        ? <Puzzle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{skill.name}</div>
        {skill.valid ? (
          skill.description
            ? <p className="mt-0.5 line-clamp-2 text-muted-foreground">{skill.description}</p>
            : <p className="mt-0.5 text-muted-foreground/70 italic">No description in SKILL.md frontmatter.</p>
        ) : (
          <p className="mt-0.5 text-destructive/80">{skill.reason ?? "Not a valid skill."}</p>
        )}
      </div>
      <button
        type="button"
        title="Delete skill"
        aria-label="Delete skill"
        className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        onClick={e => { e.stopPropagation(); onDelete() }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function SkillDetailDialog({
  skill,
  onClose,
}: {
  skill: SkillCatalogItem | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!skill} onOpenChange={open => { if (!open) onClose() }}>
      {skill && <SkillDetailContent key={skill.slug} skill={skill} />}
    </Dialog>
  )
}

function SkillDetailContent({ skill }: { skill: SkillCatalogItem }) {
  const base = `/${skill.slug}`
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
    <DialogContent className="sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>{skill.name}</DialogTitle>
        <DialogDescription className="sr-only">Contents of the {skill.name} skill.</DialogDescription>
      </DialogHeader>
      <div className="flex h-[70vh] min-w-0 gap-3 text-xs">
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
    </DialogContent>
  )
}
