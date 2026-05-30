"use client"

// SkillBrowserPanel — global skill library, rendered at the altitude of a
// *library* rather than a file tree: one row per skill (a top-level `<slug>/`
// folder), showing the name + description parsed from its SKILL.md frontmatter,
// backed by /api/v1/skills/catalog. Operations are skill-grained — upload a
// .zip (= add a skill), delete a skill, click to inspect its SKILL.md + assets.
// Stray top-level files or folders missing a SKILL.md are surfaced as invalid
// rows so they can be found and removed, instead of masquerading as skills.
//
// Clicking a skill opens it as a tab in the main pane (see SkillView), where
// the raw per-file tree the skillmgr exposes (list/read) is browsed.

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Loader2,
  Puzzle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { tabHref } from "@/lib/tabs-store"
import {
  deleteSkillFile,
  listSkillCatalog,
  uploadSkillZip,
  type SkillCatalogItem,
} from "@/lib/api"

const MIN_REFRESH_SPIN_MS = 1000

export function SkillBrowserPanel() {
  const router = useRouter()
  const [catalog, setCatalog] = useState<SkillCatalogItem[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
            title="Refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Upload skill .zip"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
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
            onOpen={() => { if (skill.valid) router.push(tabHref({ kind: "skill", id: skill.slug })) }}
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
