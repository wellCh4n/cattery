"use client"

import { use, useEffect, useMemo } from "react"
import { Loader2, Plug, TriangleAlert } from "lucide-react"
import { ChatPanel } from "@/components/chat-panel"
import { Button } from "@/components/ui/button"
import { type Channel, registerChannelConversation, type Session } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { findChannel, platformName, useProjectChannelsStore } from "@/lib/channels-store"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  projectId: string
  channelId: string
}

// A chat channel's conversation, shown like a session's: its id is the
// channel id, served under /channels (see registerChannelConversation).
export default function ChannelPage({ params }: { params: Promise<PageParams> }) {
  const { projectId, channelId } = use(params)
  registerChannelConversation(channelId)
  const resource = useProjectChannelsStore(state => state.entries[projectId])
  const channel = useProjectChannelsStore(state => findChannel(state.entries, projectId, channelId))
  useDocumentTitle(channel?.name)

  useEffect(() => {
    void useProjectChannelsStore.getState().load(projectId)
  }, [projectId])

  const session = useMemo(() => channel && asSession(channel), [channel])

  if (channel && session) {
    return (
      <div className="flex h-full flex-col">
        <ChannelNotice channel={channel} />
        <div className="min-h-0 flex-1">
          <ChatPanel session={session} channel={channel} />
        </div>
      </div>
    )
  }
  if (!resource?.data && !resource?.error) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  }
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Plug className="size-8 text-muted-foreground/50" />
      <p className="mt-2 text-xs text-muted-foreground">{resource?.error || "This channel was deleted."}</p>
      {resource?.error && <Button className="mt-3" variant="outline" onClick={() => void useProjectChannelsStore.getState().invalidate(projectId)}>Retry</Button>}
    </div>
  )
}

function asSession(channel: Channel): Session {
  return {
    session_id: channel.channel_id,
    project_id: channel.project_id,
    created_by_user_id: channel.created_by_user_id,
    created_by_username: channel.created_by_username,
    created_by_name: channel.created_by_name,
    created_by_avatar_version: channel.created_by_avatar_version,
    model: channel.model,
    effort: channel.effort,
    status: "ready",
    phase: null,
    title: channel.name,
    created_at: channel.created_at,
    last_seen_at: null,
  }
}

// What keeps the channel from its chat, if anything, above the conversation.
function ChannelNotice({ channel }: { channel: Channel }) {
  const userId = useAuthStore(state => state.user?.user_id)
  const mine = userId === channel.created_by_user_id
  const platform = platformName(channel.type)
  let text: string | null = null
  if (!channel.enabled) text = `Disconnected from ${platform}.`
  else if (channel.status === "expired") text = `The WeChat login expired.${mine ? " Edit the channel to scan again." : ""}`
  else if (channel.status === "error") text = `Can't reach ${platform}${channel.last_error ? `: ${channel.last_error}` : "."}`
  else if (!channel.bound && mine && channel.bind_code) text = `Send /bind ${channel.bind_code} to the bot in ${platform} to connect your account.`
  else if (!channel.bound) text = `Waiting for its creator to connect their ${platform} account.`
  if (!text) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
    </div>
  )
}
