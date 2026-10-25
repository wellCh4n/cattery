"use client"

import { PROJECT_SKILLS_DIR, createSkillFolder, deleteFile, deleteSkillFile, installSkill, listInstalledSkills, uploadProjectSkill, listSkillCatalog, listSkills, readSkillFile, renameSkillFile, uploadSkillZip } from "@/lib/api"
import { refreshFiles } from "@/lib/files-store"
import { createResourceStore } from "@/lib/resource-store"

export const useSkillsStore = createResourceStore(() => listSkillCatalog())
export const useSkillDirectoriesStore = createResourceStore(listSkills)
export const useSkillContentsStore = createResourceStore(readSkillFile)
// Slugs installed in each project, keyed by project id.
export const useInstalledSkillsStore = createResourceStore(listInstalledSkills)
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
  async install(projectId: string, slug: string) {
    try { await installSkill(projectId, slug) }
    finally { await afterProjectSkillsChange(projectId) }
  },
  async uploadToProject(projectId: string, file: File) {
    try { return await uploadProjectSkill(projectId, file) }
    finally { await afterProjectSkillsChange(projectId) }
  },
  async uninstall(projectId: string, slug: string) {
    try { await deleteFile(projectId, `${PROJECT_SKILLS_DIR}/${slug}`) }
    finally { await afterProjectSkillsChange(projectId) }
  },
  reset() {
    useInstalledSkillsStore.getState().reset()
    useSkillsStore.getState().reset()
    useSkillDirectoriesStore.getState().reset()
    useSkillContentsStore.getState().reset()
  },
}

function afterProjectSkillsChange(projectId: string) {
  return Promise.all([
    useInstalledSkillsStore.getState().invalidate(projectId),
    refreshFiles(projectId, [PROJECT_SKILLS_DIR]),
  ])
}
