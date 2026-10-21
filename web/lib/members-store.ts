"use client"

import { createProjectMember, deleteProjectMember, listProjectMembers, type ProjectMember } from "@/lib/api"
import { createResourceStore } from "@/lib/resource-store"

export const useMembersStore = createResourceStore<ProjectMember[]>(listProjectMembers)
export const memberActions = {
  async add(projectId: string, username: string) {
    const member = await createProjectMember(projectId, { username })
    useMembersStore.setState(state => ({ entries: { ...state.entries, [projectId]: {
      ...state.entries[projectId], loading: false, stale: true, error: null,
      data: [...(state.entries[projectId]?.data ?? []).filter(item => item.user_id !== member.user_id), member]
        .sort((a, b) => a.username.localeCompare(b.username)),
    } } }))
    await useMembersStore.getState().invalidate(projectId)
    return member
  },
  async remove(projectId: string, userId: string) {
    await deleteProjectMember(projectId, userId)
    useMembersStore.setState(state => ({ entries: { ...state.entries, [projectId]: {
      ...state.entries[projectId], loading: false, stale: true, error: null,
      data: (state.entries[projectId]?.data ?? []).filter(member => member.user_id !== userId),
    } } }))
    await useMembersStore.getState().invalidate(projectId)
  },
}
