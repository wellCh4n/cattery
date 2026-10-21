"use client"

import { createSkillFolder, deleteSkillFile, listSkillCatalog, listSkills, readSkillFile, renameSkillFile, uploadSkillZip } from "@/lib/api"
import { createResourceStore } from "@/lib/resource-store"

export const useSkillsStore = createResourceStore(() => listSkillCatalog())
export const useSkillDirectoriesStore = createResourceStore(listSkills)
export const useSkillContentsStore = createResourceStore(readSkillFile)
export async function refreshSkills() {
  await Promise.all([
    useSkillsStore.getState().invalidate("catalog"),
    ...Object.keys(useSkillDirectoriesStore.getState().entries).map(path => useSkillDirectoriesStore.getState().invalidate(path)),
    ...Object.keys(useSkillContentsStore.getState().entries).map(path => useSkillContentsStore.getState().invalidate(path)),
  ])
}
export const skillActions = {
  async upload(dir: string, file: File) {
    try { return await uploadSkillZip(dir, file) }
    finally { await refreshSkills() }
  },
  async remove(path: string) { await deleteSkillFile(path); await refreshSkills() },
  async rename(path: string, name: string) { const result = await renameSkillFile(path, name); await refreshSkills(); return result },
  async createFolder(dir: string, name: string) { const result = await createSkillFolder(dir, name); await refreshSkills(); return result },
  reset() {
    useSkillsStore.getState().reset()
    useSkillDirectoriesStore.getState().reset()
    useSkillContentsStore.getState().reset()
  },
}
