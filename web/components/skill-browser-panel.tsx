"use client"

// SkillBrowserPanel — the current project's skills, laid out like VS Code's
// extensions view: an Installed section (the project's ~/.agents/skills,
// which its agent loads) above a Library section (the platform-wide library,
// /api/v1/skills/catalog), split by a draggable divider; either collapses.
// Searching replaces both with library matches. Library rows are `<slug>/`
// folders with the name + description from their SKILL.md frontmatter. Installing a library skill copies it into the project;
// Upload adds a `.zip` straight to the project, never to the library, which
// only admins change (the Skill management page). Folders in
// ~/.agents/skills that aren't in the library (uploaded, written by the agent
// or by hand) are listed as project-only skills.
//
// Clicking a library skill opens it as a tab in the main pane (see
// SkillView); a project-only skill opens its SKILL.md as a file.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ChevronRight,
  Loader2,
  PackageMinus,
  PackagePlus,
  Puzzle,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { tabHref } from "@/lib/tabs-store"
import { PROJECT_SKILLS_DIR } from "@/lib/api"
import { itemHover, itemInset } from "@/components/tree-row"
import { cn } from "@/lib/utils"
import {
  type SkillCatalogItem,
} from "@/lib/api"

import { refreshSkills, skillActions, useInstalledSkillsStore, useSkillsStore } from "@/lib/skills-store"
import { RefreshButton } from "@/components/refresh-button"

export function SkillBrowserPanel({ active, projectId }: { active: boolean; projectId: string }) {
  const router = useRouter()
  const resource = useSkillsStore(state => state.entries.catalog)
  const catalog = resource?.data ?? null
  const refreshing = resource?.loading ?? false
  const [actionError, setError] = useState<string | null>(null)
  const error = actionError ?? resource?.error
  const [uploading, setUploading] = useState(false)
  // The search box; empty lists only the project's installed skills.
  const [uninstallTarget, setUninstallTarget] = useState<SkillRowItem | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const installed = useInstalledSkillsStore(state => state.entries[projectId]?.data)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState({ installed: false, library: false })
  const split = useSplit()

  useEffect(() => {
    if (active) void refreshSkills()
  }, [active])

  // The agent can change ~/.agents/skills too, so reread it whenever shown.
  useEffect(() => {
    if (active) void useInstalledSkillsStore.getState().load(projectId, true)
  }, [active, projectId])

  async function refresh() {
    setError(null)
    await Promise.all([
      refreshSkills(),
      useInstalledSkillsStore.getState().invalidate(projectId),
    ])
  }

  async function changeInstall(skill: SkillCatalogItem, install: boolean) {
    setPending(skill.slug)
    setError(null)
    try {
      if (install) await skillActions.install(projectId, skill.slug)
      else await skillActions.uninstall(projectId, skill.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : `${install ? "install" : "uninstall"} failed`)
    } finally {
      setPending(null)
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
      // A skill zip is a `<slug>/SKILL.md (+assets)` folder; it lands in the
      // project's ~/.agents/skills/<slug>, so it shows as installed.
      await skillActions.uploadToProject(projectId, file)
      setQuery("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(false)
    }
  }

  const loading = (catalog === null || installed === undefined) && !error
  const needle = query.trim().toLowerCase()
  const bySlug = new Map((catalog ?? []).map(skill => [skill.slug, skill]))
  // Installed folders missing from the library still show, by folder name.
  const installedRows: SkillRowItem[] = (installed ?? []).map(slug => bySlug.get(slug) ?? {
    slug, name: slug, description: "", valid: true, mtime: 0, local: true,
  }).sort((a, b) => a.name.localeCompare(b.name))
  // Members can't fix broken library entries, so only admins see those (on
  // the Skill management page).
  const libraryRows = (catalog ?? []).filter(skill => skill.valid)
  const searchRows = needle
    ? libraryRows.filter(skill => [skill.name, skill.slug, skill.description].some(text => text.toLowerCase().includes(needle)))
    : []
  const isInstalled = (slug: string) => installed?.includes(slug) ?? false
  const bothOpen = !collapsed.installed && !collapsed.library
  // Sizes in the sections' column: the Installed section's basis moves
  // between its split share, header only and everything but the Library
  // header, and the Library section fills the rest (header only when both
  // are collapsed), so expanding and collapsing animate. The divider row
  // (h-2) is always there; it only drags while both are open.
  const installedBasis = collapsed.installed ? HEADER_HEIGHT
    : collapsed.library ? `calc(100% - ${HEADER_HEIGHT} - 0.5rem)`
    : `${split.ratio * 100}%`
  const libraryFlex = collapsed.installed && collapsed.library ? `0 0 ${HEADER_HEIGHT}` : "1 1 0%"

  function openSkill(skill: SkillRowItem) {
    if (!skill.valid) return
    router.push(skill.local
      ? tabHref({ kind: "file", projectId, id: `${PROJECT_SKILLS_DIR}/${skill.slug}/SKILL.md` })
      : tabHref({ kind: "skill", id: skill.slug }))
  }

  function row(skill: SkillRowItem, inLibrary: boolean) {
    const installedHere = isInstalled(skill.slug)
    return (
      <SkillRow
        key={skill.slug}
        skill={skill}
        installed={installedHere}
        markInstalled={inLibrary && installedHere}
        pending={pending === skill.slug}
        onOpen={() => openSkill(skill)}
        onInstall={() => void changeInstall(skill, true)}
        onUninstall={() => setUninstallTarget(skill)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between px-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Skills
        </span>
        <div className="flex items-center gap-1">
          <RefreshButton aria-label="Refresh" onClick={() => void refresh()} refreshing={refreshing} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Upload skill .zip to project"
            title="Upload skill .zip to project"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
          </Button>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".zip,application/zip" hidden onChange={onPickerChange} />

      <div className="shrink-0 px-2 pb-2">
        <Input
          className="h-7 text-xs md:text-xs"
          type="search"
          placeholder="Search the skill library"
          aria-label="Search the skill library"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {error && (
        <div className="shrink-0 px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      ) : needle ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-1.5 pb-1">
            {searchRows.length === 0
              ? <p className="px-3 py-2 text-xs text-muted-foreground">No matching skills in the library</p>
              : searchRows.map(skill => row(skill, true))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <Section
            title="Installed"
            count={installedRows.length}
            collapsed={collapsed.installed}
            onToggle={() => setCollapsed(c => ({ ...c, installed: !c.installed }))}
            style={{ flex: `0 0 ${installedBasis}` }}
            animate={!split.dragging}
          >
            {installedRows.length === 0 && !uploading && (
              <div className="flex flex-col items-center px-4 py-6 text-center">
                <Puzzle className="size-8 text-muted-foreground/50" />
                <p className="mt-2 text-xs text-muted-foreground">No skills installed</p>
                <p className="mt-1 text-xs text-muted-foreground/70">Install one from the library, or upload a .zip.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-32"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload />
                  Upload
                </Button>
              </div>
            )}
            {installedRows.map(skill => row(skill, false))}
            {uploading && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Extracting skill…
              </div>
            )}
          </Section>
          {bothOpen ? (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize sections"
              className="group/split flex h-2 shrink-0 cursor-row-resize touch-none items-center"
              {...split.handleProps}
            >
              <div className="h-px w-full bg-border transition-colors group-hover/split:bg-ring group-active/split:bg-ring" />
            </div>
          ) : (
            <div className="flex h-2 shrink-0 items-center"><div className="h-px w-full bg-border" /></div>
          )}
          <Section
            title="Library"
            count={libraryRows.length}
            collapsed={collapsed.library}
            onToggle={() => setCollapsed(c => ({ ...c, library: !c.library }))}
            style={{ flex: libraryFlex }}
            animate
          >
            {libraryRows.length === 0
              ? <p className="px-3 py-2 text-xs text-muted-foreground">The skill library is empty.</p>
              : libraryRows.map(skill => row(skill, true))}
          </Section>
        </div>
      )}

      <ConfirmDialog
        open={!!uninstallTarget}
        onOpenChange={open => { if (!open) setUninstallTarget(null) }}
        title={uninstallTarget ? `Uninstall ${uninstallTarget.name}?` : "Uninstall?"}
        description={uninstallTarget?.local
          ? "This deletes the skill's folder from this project's ~/.agents/skills. It isn't in the library, so this cannot be undone."
          : "This deletes the skill's folder from this project's ~/.agents/skills, including any changes made to it there. The library copy stays."}
        confirmLabel="Uninstall"
        destructive
        onConfirm={() => {
          if (uninstallTarget) void changeInstall(uninstallTarget, false)
          setUninstallTarget(null)
        }}
      />
    </div>
  )
}

// A catalog entry, or an installed folder that isn't in the library.
type SkillRowItem = SkillCatalogItem & { local?: boolean }

const SPLIT_KEY = "cattery.skills.split"
const SPLIT_MIN = 0.15
const SPLIT_MAX = 0.85
// A section header's height (h-7).
const HEADER_HEIGHT = "1.75rem"

// useSplit tracks the Installed section's share of the sections' height,
// dragged by the divider between them and remembered across reloads.
function useSplit() {
  const [ratio, setRatio] = useState(0.5)
  // Sizes follow the pointer directly while dragging, without easing.
  const [dragging, setDragging] = useState(false)
  // Server render uses the default; the saved split is read after mount.
  useEffect(() => {
    const saved = Number(localStorage.getItem(SPLIT_KEY))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved >= SPLIT_MIN && saved <= SPLIT_MAX) setRatio(saved)
  }, [])
  const handleProps = {
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
    },
    onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
      // The divider sits directly in the sections' container.
      const box = e.currentTarget.parentElement?.getBoundingClientRect()
      if (!box?.height || !e.currentTarget.hasPointerCapture(e.pointerId)) return
      setRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (e.clientY - box.top) / box.height)))
    },
    onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      setDragging(false)
      localStorage.setItem(SPLIT_KEY, String(ratio))
    },
    onLostPointerCapture() { setDragging(false) },
  }
  return { ratio, dragging, handleProps }
}

// Section is one collapsible, independently scrolling part of the panel. Its
// size comes from the caller's flex style; the body stays mounted and is
// clipped while collapsed, so the size change can ease.
function Section({
  title,
  count,
  collapsed,
  onToggle,
  style,
  animate,
  children,
}: {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  style: React.CSSProperties
  animate: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        animate && "transition-[flex-basis,flex-grow] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={style}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1 px-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={onToggle}
      >
        <ChevronRight className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", !collapsed && "rotate-90")} />
        <span className="flex-1 text-left">{title}</span>
        <span className="font-normal tabular-nums">{count}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto" inert={collapsed}>
        <div className="flex flex-col gap-1.5 pb-1">{children}</div>
      </div>
    </section>
  )
}

function SkillRow({
  skill,
  installed,
  markInstalled,
  pending,
  onOpen,
  onInstall,
  onUninstall,
}: {
  skill: SkillRowItem
  installed: boolean
  // Library rows flag skills the project already has.
  markInstalled: boolean
  pending: boolean
  onOpen: () => void
  onInstall: () => void
  onUninstall: () => void
}) {
  const action = "shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100"
  return (
    <div
      className={cn(
        "group flex items-start gap-2 px-2 py-2 text-[13px] transition-colors",
        itemInset,
        skill.valid ? cn("cursor-pointer", itemHover) : "bg-destructive/5",
      )}
      onClick={skill.valid ? onOpen : undefined}
    >
      {skill.valid
        ? <Puzzle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{skill.name}</span>
          {skill.local && <Badge variant="outline">Project only</Badge>}
          {markInstalled && <Badge variant="secondary">Installed</Badge>}
        </div>
        {skill.local ? (
          <p className="mt-0.5 text-xs text-muted-foreground/70 italic">Not in the library.</p>
        ) : skill.valid ? (
          skill.description
            ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
            : <p className="mt-0.5 text-xs text-muted-foreground/70 italic">No description in SKILL.md frontmatter.</p>
        ) : (
          <p className="mt-0.5 text-xs text-destructive/80">{skill.reason ?? "Not a valid skill."}</p>
        )}
      </div>
      {pending ? (
        <Loader2 className="m-1 size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : !installed && skill.valid ? (
        <button
          type="button"
          aria-label="Install in project"
          title="Install in project"
          className={cn(action, "hover:bg-muted hover:text-foreground")}
          onClick={e => { e.stopPropagation(); onInstall() }}
        >
          <PackagePlus className="size-3.5" />
        </button>
      ) : installed ? (
        <button
          type="button"
          aria-label="Uninstall from project"
          title="Uninstall from project"
          className={cn(action, "hover:bg-destructive/10 hover:text-destructive")}
          onClick={e => { e.stopPropagation(); onUninstall() }}
        >
          <PackageMinus className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
