"use client"

// Skill management — the admin view of the platform-wide skill library. Only
// admins upload or delete library skills (the backend enforces it); everyone
// else browses the library from a project's Skills panel and installs from it.
// Deleting a library skill leaves projects' installed copies alone.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Puzzle, Trash2, TriangleAlert, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { type SkillCatalogItem } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { refreshSkills, skillActions, useSkillsStore } from "@/lib/skills-store"
import { tabHref } from "@/lib/tabs-store"

export default function AdminSkillsPage() {
  const router = useRouter()
  const me = useAuthStore(s => s.user)
  const resource = useSkillsStore(state => state.entries.catalog)
  const catalog = resource?.data ?? null
  const [actionError, setError] = useState<string | null>(null)
  const error = actionError ?? resource?.error
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillCatalogItem | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Non-admins don't see the menu link; the server 403s their writes anyway.
  useEffect(() => {
    if (me && !me.is_admin) router.replace("/")
  }, [me, router])

  useEffect(() => { void refreshSkills() }, [])

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
      // A skill zip is a `<slug>/SKILL.md (+assets)` folder, extracted at the root.
      await skillActions.upload("/", file)
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(false)
    }
  }

  async function confirmDelete(target: SkillCatalogItem) {
    setError(null)
    try {
      await skillActions.remove(`/${target.slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed")
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="font-heading text-base font-semibold flex-1">Skill library</h1>
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Upload className="size-3.5 mr-1" />}
            Upload skill
          </Button>
        </div>
        <input ref={fileInputRef} type="file" accept=".zip,application/zip" hidden onChange={onPickerChange} />

        <p className="mb-4 text-xs text-muted-foreground">
          Skills here are available to every project to install. Upload a .zip of one
          {" "}<code>&lt;slug&gt;/SKILL.md</code> folder. Deleting a skill keeps the copies projects already installed.
        </p>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive mb-4">
            {error}
          </div>
        )}

        {catalog === null ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            {!error && <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : catalog.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border py-12 text-center">
            <Puzzle className="size-8 text-muted-foreground opacity-50" />
            <p className="mt-2 text-xs text-muted-foreground">No skills in the library</p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left">
                  <th className="w-48 px-3 py-2 font-medium">Skill</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="w-28 px-3 py-2 font-medium">Updated</th>
                  <th className="w-12 px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {catalog.map(skill => (
                  <tr
                    key={skill.slug}
                    className={skill.valid ? "border-t group cursor-pointer hover:bg-muted/40" : "border-t group bg-destructive/5"}
                    onClick={() => { if (skill.valid) router.push(tabHref({ kind: "skill", id: skill.slug })) }}
                  >
                    <td className="px-3 py-2 align-top">
                      <span className="flex items-center gap-2">
                        {skill.valid
                          ? <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
                          : <TriangleAlert className="size-3.5 shrink-0 text-destructive" />}
                        <span className="truncate font-medium">{skill.name}</span>
                      </span>
                      {skill.name !== skill.slug && (
                        <span className="mt-0.5 block truncate pl-5.5 text-xs text-muted-foreground">{skill.slug}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                      {skill.valid
                        ? <span className="line-clamp-2">{skill.description || <span className="italic">No description</span>}</span>
                        : <span className="text-destructive/80">{skill.reason ?? "Not a valid skill."}</span>}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(skill.mtime * 1000).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <button
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer transition"
                        title="Delete from library"
                        aria-label={`Delete ${skill.name}`}
                        onClick={e => { e.stopPropagation(); setDeleteTarget(skill) }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => { if (!open) setDeleteTarget(null) }}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete?"}
        description="This removes the skill and all its files from the global library. Projects that installed it keep their copy. This cannot be undone."
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
