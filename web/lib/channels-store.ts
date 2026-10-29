"use client"

import { type Channel, type ChannelList, type ChannelType, listChannels } from "@/lib/api"
import { createResourceStore } from "@/lib/resource-store"

export function platformName(type: ChannelType): string {
  switch (type) {
    case "feishu": return "Feishu"
    case "lark":   return "Lark"
    case "weixin": return "WeChat"
  }
}

// A project's chat channels, shared by its members. Changes arrive as live
// "channels" events (see lib/live.ts), which reread the list.
export const useProjectChannelsStore = createResourceStore<ChannelList>(listChannels)

// applyChannel puts a channel this tab just created or changed into its
// project's list ahead of the reread that follows it.
export function applyChannel(channel: Channel) {
  update(channel.project_id, channels => [channel, ...channels.filter(c => c.channel_id !== channel.channel_id)])
}

export function forgetChannel(projectId: string, channelId: string) {
  update(projectId, channels => channels.filter(c => c.channel_id !== channelId))
}

function update(projectId: string, fn: (channels: Channel[]) => Channel[]) {
  useProjectChannelsStore.setState(state => {
    const entry = state.entries[projectId]
    const list = entry?.data ?? { enabled: true, channels: [] }
    return { entries: { ...state.entries, [projectId]: {
      ...entry, loading: false, stale: true, error: null,
      data: { ...list, channels: fn(list.channels).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.channel_id.localeCompare(b.channel_id)) },
    } } }
  })
  void useProjectChannelsStore.getState().invalidate(projectId)
}

// findChannel looks a channel up in its project's loaded list.
export function findChannel(entries: ReturnType<typeof useProjectChannelsStore.getState>["entries"], projectId: string, channelId: string): Channel | undefined {
  return entries[projectId]?.data?.channels.find(c => c.channel_id === channelId)
}
