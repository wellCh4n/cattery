"use client"

// SkillView — renders one skill filling its container: a header (skill name)
// over a two-pane body. Left is the skill's file tree (lazy-listed via the
// skillmgr list endpoint); right previews the selected file — SKILL.md and
// other markdown render through Markdown (with a source toggle), everything
// else through the shiki-highlighted FileViewer. A markdown file's YAML
// frontmatter (the skill's name, description, license, …) is parsed out of the
// body and shown as a metadata card above it. This is the main-pane
// counterpart to the skill browser's old modal.

import { useCallback, useEffect, useMemo, useState } from "react"
import { File as FileIcon, Folder, Loader2, Puzzle, TriangleAlert } from "lucide-react"
import { FileViewer } from "@/components/file-viewer"
import { Markdown } from "@/components/markdown"
import { Tree, type TreeNode } from "@/components/tree"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { type FileEntry } from "@/lib/api"
import { splitFrontmatter, type Frontmatter } from "@/lib/frontmatter"
import { SKILL_FIELDS, SKILL_FIELD_KEYS, validateSkillManifest } from "@/lib/skill-manifest"
import { useSkillDirectoriesStore, useSkillContentsStore } from "@/lib/skills-store"

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
  const directories = useSkillDirectoriesStore(state => state.entries)
  const childrenByPath = useMemo(() => Object.fromEntries(
    Object.entries(directories).filter(([, entry]) => entry.data).map(([path, entry]) => [path, sortEntries(entry.data!)]),
  ), [directories])
  const loadingPaths = useMemo(() => new Set(Object.keys(directories).filter(path => directories[path].loading)), [directories])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string>(manifestPath)
  const [mode, setMode] = useState<PreviewMode>("preview")
  const resource = useSkillContentsStore(state => state.entries[selected])
  const data = resource?.data ?? null
  const loading = !data && (resource?.loading ?? true)
  const error = resource?.error
  const loadDir = useCallback((path: string) => useSkillDirectoriesStore.getState().load(path), [])

  useEffect(() => { void loadDir(base) }, [base, loadDir])
  useEffect(() => { void useSkillContentsStore.getState().load(selected) }, [selected])

  function toggleExpand(path: string) {
    const opening = !expanded.has(path)
    setExpanded(prev => {
      const next = new Set(prev)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
    if (opening && !childrenByPath[path]) void loadDir(path)
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
  const parsed = useMemo(
    () => (showMarkdown && data && !data.binary ? splitFrontmatter(data.content ?? "") : null),
    [showMarkdown, data],
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="flex w-44 shrink-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex h-9 shrink-0 items-center border-b px-2">
            <span className="text-2xs font-medium uppercase tracking-wide text-foreground/70">
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
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={selected}>
              {selected}
            </span>
            {data?.truncated && (
              <span className="shrink-0 text-2xs text-amber-600 dark:text-amber-400">truncated</span>
            )}
            {isMd && (
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
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && <div className="p-3"><Loader2 className="size-4 animate-spin" /></div>}
            {error && <p className="p-3 text-destructive">{error}</p>}
            {!loading && !error && data?.binary && (
              <p className="p-3 italic text-muted-foreground">Binary file ({data.size} bytes) — preview not supported.</p>
            )}
            {!loading && !error && data && !data.binary && showMarkdown && (
              <div className="flex flex-col gap-3 p-3">
                {parsed?.frontmatter && <FrontmatterCard frontmatter={parsed.frontmatter} skillDir={selected === manifestPath ? slug : undefined} />}
                <Markdown className="text-foreground">{parsed?.body ?? data.content ?? ""}</Markdown>
              </div>
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

// FrontmatterCard shows a markdown file's frontmatter. For the skill's own
// SKILL.md (`skillDir` set) the standard fields it sets get labelled rows and
// the values are checked against the spec; other markdown files just list
// whatever keys they carry.
function FrontmatterCard({ frontmatter, skillDir }: { frontmatter: Frontmatter; skillDir?: string }) {
  if (!frontmatter.ok) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-destructive">Invalid frontmatter: {frontmatter.error}</p>
        <pre className="overflow-x-auto font-mono text-2xs text-muted-foreground">{frontmatter.raw}</pre>
      </div>
    )
  }
  const { data } = frontmatter
  const isManifest = skillDir !== undefined
  const name = typeof data.name === "string" ? data.name : null
  const description = typeof data.description === "string" ? data.description.trim() : null
  const standard = isManifest
    ? SKILL_FIELDS.filter(field => field.key !== "name" && field.key !== "description" && data[field.key] != null)
    : []
  const other = Object.entries(data).filter(([key, value]) =>
    value != null && (isManifest ? !SKILL_FIELD_KEYS.has(key) : key !== "name" && key !== "description"))
  const issues = isManifest ? validateSkillManifest(data, skillDir) : []
  if (!isManifest && !name && !description && other.length === 0) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      {name && <div className="font-mono text-sm font-semibold">{name}</div>}
      {description && <p className="whitespace-pre-line leading-relaxed text-muted-foreground">{description}</p>}
      {standard.length > 0 && (
        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t pt-2">
          {standard.map(field => (
            <FrontmatterRow
              key={field.key}
              name={field.label}
              title={`${field.key} — ${field.hint}`}
              tag={field.experimental ? "experimental" : undefined}
            >
              {field.key === "disable-model-invocation" && typeof data[field.key] === "boolean"
                ? <ModelInvocation disabled={data[field.key] as boolean} />
                : <FrontmatterValue name={field.key} value={data[field.key]} />}
            </FrontmatterRow>
          ))}
        </dl>
      )}
      {other.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5 border-t pt-2">
          {isManifest && (
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Other fields</span>
          )}
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {other.map(([key, value]) => (
              <FrontmatterRow key={key} name={key} mono>
                <FrontmatterValue name={key} value={value} />
              </FrontmatterRow>
            ))}
          </dl>
        </div>
      )}
      {issues.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 border-t pt-2 text-amber-700 dark:text-amber-400">
          {issues.map(issue => (
            <li key={issue} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span>{issue}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ModelInvocation({ disabled }: { disabled: boolean }) {
  return disabled
    ? <span className="flex flex-wrap items-center gap-1.5 leading-5"><Badge variant="outline">Disabled</Badge><span className="text-muted-foreground">only runs via /skill:name</span></span>
    : <Badge variant="secondary">Enabled</Badge>
}

function FrontmatterRow({
  name,
  title,
  tag,
  mono,
  children,
}: {
  name: string
  title?: string
  tag?: string
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <>
      <dt className={cn("flex items-center gap-1 text-2xs leading-5 text-muted-foreground", mono && "font-mono")} title={title}>
        {name}
        {tag && <span className="rounded-sm border px-1 text-[10px] leading-3.5 text-muted-foreground/80">{tag}</span>}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function FrontmatterValue({ name, value }: { name: string; value: unknown }) {
  if (typeof value === "boolean") {
    return <Badge variant={value ? "secondary" : "outline"}>{value ? "true" : "false"}</Badge>
  }
  // allowed-tools is a space-delimited string per the spec; tolerate a list too.
  const items = name === "allowed-tools"
    ? (typeof value === "string" ? value.split(/\s+/).filter(Boolean) : Array.isArray(value) ? value.map(String) : null)
    : Array.isArray(value) && value.every(v => typeof v !== "object" || v === null) ? value.map(String) : null
  if (items) {
    return (
      <div className="flex flex-wrap gap-1">
        {items.map((item, i) => <Badge key={i} variant="outline" className="font-mono">{item}</Badge>)}
      </div>
    )
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return <span className="leading-5 text-muted-foreground/60">Empty</span>
    return (
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        {entries.map(([key, v]) => (
          <FrontmatterRow key={key} name={key} mono>
            <FrontmatterValue name={key} value={v} />
          </FrontmatterRow>
        ))}
      </dl>
    )
  }
  if (typeof value === "string" || typeof value === "number") {
    return <span className="whitespace-pre-line break-words leading-5">{String(value)}</span>
  }
  return <code className="break-all font-mono text-2xs leading-5">{JSON.stringify(value)}</code>
}
