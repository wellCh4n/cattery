"use client"

import { createFolder, deleteFile, listFiles, moveFile, renameFile, uploadFile, type FileEntry } from "@/lib/api"
import { createResourceStore } from "@/lib/resource-store"

export const fileKey = (projectId: string, path: string) => JSON.stringify([projectId, path])
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/"
export const useFilesStore = createResourceStore<FileEntry[]>(async key => {
  const [projectId, path] = JSON.parse(key) as [string, string]
  return (await listFiles(projectId, path)).sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name))
})

// Project-wide requests are batched. A tool finishing during a refresh queues
// another pass rather than losing its change notification.
type Refresh = { dirty: boolean; paths: Set<string>; promise: Promise<void> }
const refreshing = new Map<string, Refresh>()
let epoch = 0
export function refreshFiles(projectId: string, paths: string[] = [], delay = 0): Promise<void> {
  const existing = refreshing.get(projectId)
  if (existing) {
    existing.dirty = true
    paths.forEach(path => existing.paths.add(path))
    return existing.promise
  }
  const startedEpoch = epoch
  const job: Refresh = { dirty: true, paths: new Set(paths), promise: Promise.resolve() }
  refreshing.set(projectId, job)
  job.promise = Promise.resolve().then(async () => {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    while (job.dirty && epoch === startedEpoch) {
      job.dirty = false
      const wanted = new Set(job.paths)
      job.paths.clear()
      for (const key of Object.keys(useFilesStore.getState().entries)) {
        const [project, path] = JSON.parse(key) as [string, string]
        if (project === projectId) wanted.add(path)
      }
      const visit = async (path: string): Promise<void> => {
        if (epoch !== startedEpoch) return
        const entries = await useFilesStore.getState().invalidate(fileKey(projectId, path))
        if (!entries || epoch !== startedEpoch) return
        const prefix = path === "/" ? "/" : `${path}/`
        const directories = new Set(entries.filter(entry => entry.type === "dir").map(entry => prefix + entry.name))
        for (const key of Object.keys(useFilesStore.getState().entries)) {
          const [project, candidate] = JSON.parse(key) as [string, string]
          if (project !== projectId || candidate === path || !candidate.startsWith(prefix)) continue
          const child = prefix + candidate.slice(prefix.length).split("/")[0]
          if (!directories.has(child)) useFilesStore.getState().drop(key)
        }
        await Promise.all(entries.filter(entry => entry.type === "dir").map(async entry => {
          const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
          if (wanted.has(child) || [...wanted].some(p => p.startsWith(`${child}/`))) await visit(child)
        }))
      }
      await visit("/")
    }
  }).finally(() => { if (refreshing.get(projectId) === job) refreshing.delete(projectId) })
  return job.promise
}

export const fileActions = {
  async upload(projectId: string, dir: string, files: File[]) {
    try { for (const file of files) await uploadFile(projectId, dir, file) }
    finally { await refreshFiles(projectId, [dir]) }
  },
  async remove(projectId: string, path: string) {
    await deleteFile(projectId, path)
    await refreshFiles(projectId, [parentPath(path)])
  },
  async rename(projectId: string, path: string, name: string) {
    const result = await renameFile(projectId, path, name)
    await refreshFiles(projectId, [parentPath(path)])
    return result
  },
  async move(projectId: string, from: string, to: string) {
    await moveFile(projectId, from, to)
    await refreshFiles(projectId, [parentPath(from), to])
  },
  async createFolder(projectId: string, dir: string, name: string) {
    await createFolder(projectId, dir, name)
    await refreshFiles(projectId, [dir])
  },
  reset() { epoch++; refreshing.clear(); useFilesStore.getState().reset() },
}

// Agent paths are relative to the project home at /home/cattery (~);
// the file API uses workspace-relative paths.
// Unknown or outside-workspace paths fall back to refreshing cached directories.
export function toolChangedDirectories(input?: string): string[] {
  try {
    const value = JSON.parse(input ?? "{}") as { path?: unknown }
    if (typeof value.path !== "string") return []
    let path = value.path
    if (path.startsWith("/home/cattery/")) path = path.slice("/home/cattery/".length)
    else if (path === "/home/cattery") path = ""
    else if (path.startsWith("~/")) path = path.slice(2)
    else if (path === "~") path = ""
    else if (path.startsWith("/") || path.startsWith("~")) return []
    const parts: string[] = []
    for (const part of path.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") { if (!parts.length) return []; parts.pop() }
      else parts.push(part)
    }
    return [parentPath("/" + parts.join("/"))]
  } catch { return [] }
}
