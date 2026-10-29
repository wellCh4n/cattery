"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Eraser, Loader2, MoreHorizontal, Pencil, Plug, Plus, Trash2 } from "lucide-react"
import { AddChannelDialog, EditChannelDialog, RescanWeixinDialog, statusText } from "@/components/channel-dialogs"
import { ModelIcon } from "@/components/model-icon"
import { PlatformIcon } from "@/components/platform-icon"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RefreshButton } from "@/components/refresh-button"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { WorkspaceItemBody } from "@/components/workspace-item-body"
import { type Channel, clearChannel, deleteChannel } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { forgetChannel, platformName, useProjectChannelsStore } from "@/lib/channels-store"
import { tabForPath, useTabsStore } from "@/lib/tabs-store"
import { cn } from "@/lib/utils"
import { useWorkspaceStore } from "@/lib/workspace-store"

const EMPTY: Channel[] = []

// The platform's mark, with its connection: a green dot once connected (amber
// while it waits for /bind), a spinner while connecting, red when it can't
// connect, faded when disconnected.
function ChannelIcon({ channel }: { channel: Channel }) {
  const label = channel.enabled ? statusText(channel) : "Disconnected"
  if (channel.enabled && channel.status === "connecting") {
    return <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label={label} />
  }
  const connected = channel.enabled && channel.status === "connected"
  const failed = channel.enabled && (channel.status === "error" || channel.status === "expired")
  return (
    <span className="relative flex" title={channel.last_error ?? label}>
      <PlatformIcon type={channel.type} className={cn("size-4", failed ? "text-destructive" : "text-muted-foreground", !channel.enabled && "opacity-50")} />
      {connected && (
        <span className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background", channel.bound ? "bg-emerald-500" : "bg-amber-500")} />
      )}
    </span>
  )
}

// The project's chat channels: each a Feishu or Lark bot or WeChat login whose
// conversation opens as a tab. Everyone sees them; their creators edit them.
export function ChannelListPanel({ projectId, active }: { projectId: string; active: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const resource = useProjectChannelsStore(state => state.entries[projectId])
  const channels = resource?.data?.channels ?? EMPTY
  const enabled = resource?.data?.enabled ?? true
  const userId = useAuthStore(state => state.user?.user_id)
  const owner = useWorkspaceStore(state => state.projects.find(p => p.project_id === projectId)?.access_role === "owner")
  const closeTab = useTabsStore(state => state.closeTab)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const [clearing, setClearing] = useState<Channel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = !resource?.data && !resource?.error
  const route = tabForPath(pathname ?? "")
  const selectedId = route?.kind === "channel" ? route.id : null
  // Look dialogs' channels up live, so they show status changes as they come.
  const editingChannel = channels.find(c => c.channel_id === editing)
  const rescanChannel = channels.find(c => c.channel_id === rescanning)

  // Other members' changes and status updates arrive as live "channels" events.
  useEffect(() => {
    if (active) void useProjectChannelsStore.getState().load(projectId)
  }, [active, projectId])

  function open(channel: Channel) {
    router.push(`/channels/${channel.project_id}/${channel.channel_id}`)
  }

  async function remove(channel: Channel) {
    setError(null)
    try {
      await deleteChannel(channel.channel_id)
      forgetChannel(projectId, channel.channel_id)
      if (selectedId === channel.channel_id) router.push("/")
      closeTab({ kind: "channel", id: channel.channel_id, projectId: channel.project_id })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete channel")
    }
  }

  async function clear(channel: Channel) {
    setError(null)
    try {
      await clearChannel(channel.channel_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear the conversation")
    }
  }

  const items: TreeNode[] = channels.map(channel => {
    const mine = channel.created_by_user_id === userId
    return {
      id: `c-${channel.channel_id}`,
      expandable: false,
      selected: selectedId === channel.channel_id,
      rowClassName: "h-14 items-start py-1.5",
      onClick: () => open(channel),
      body: (
        <WorkspaceItemBody
          icon={<ChannelIcon channel={channel} />}
          title={channel.name}
          accessory={
            <span className="flex shrink-0 items-center text-muted-foreground/70">
              <ModelIcon id={channel.model} className="size-3.5" />
            </span>
          }
          creator={{ user_id: channel.created_by_user_id, username: channel.created_by_username, name: channel.created_by_name, avatar_version: channel.created_by_avatar_version }}
          timestamp={channel.created_at}
          actions={
            <>
              {mine && (
                <TreeRowAction aria-label="Edit channel" onClick={e => { e.stopPropagation(); setEditing(channel.channel_id) }}>
                  <Pencil className="size-4" />
                </TreeRowAction>
              )}
              {(mine || owner) && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    // Stays visible while its menu is open, after the pointer leaves the row.
                    render={<TreeRowAction aria-label="More actions" className="data-popup-open:inline-flex data-popup-open:bg-foreground/10" onClick={e => e.stopPropagation()} />}
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  {/* Portaled, but React events still bubble to the row and would open the channel. */}
                  <DropdownMenuContent side="bottom" align="start" className="w-auto min-w-40 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                    {mine && (
                      <>
                        <DropdownMenuItem className="cursor-pointer" onClick={() => setClearing(channel)}>
                          <Eraser />
                          Clear conversation
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem className="cursor-pointer" variant="destructive" onClick={() => setDeleting(channel)}>
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          }
        />
      ),
    }
  })


  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Channels</span>
        <div className="flex items-center gap-1">
          <RefreshButton aria-label="Refresh channels" refreshing={resource?.loading ?? false} onClick={() => { setError(null); void useProjectChannelsStore.getState().invalidate(projectId) }} />
          <Button variant="ghost" size="icon-sm" aria-label="Add channel" disabled={!enabled} onClick={() => setAdding(true)}><Plus /></Button>
        </div>
      </div>
      {!enabled && (
        <p className="px-2 py-1 text-xs text-muted-foreground">Channels are off on this server: it needs CHANNEL_SECRET_KEY.</p>
      )}
      {(error || resource?.error) && <p className="px-2 py-1 text-xs text-destructive">{error || resource?.error}</p>}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-12 items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : channels.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Plug className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">Talk to this project&apos;s agent from Feishu, Lark or WeChat</p>
            <Button variant="outline" size="sm" className="mt-3" disabled={!enabled} onClick={() => setAdding(true)}><Plus />Add channel</Button>
          </div>
        ) : <Tree items={items} />}
      </div>
      {adding && (
        <AddChannelDialog projectId={projectId} onClose={() => setAdding(false)} onCreated={channel => { setAdding(false); open(channel) }} />
      )}
      {editingChannel && (
        <EditChannelDialog
          key={editingChannel.channel_id}
          channel={editingChannel}
          onClose={() => setEditing(null)}
          onRescan={() => { setEditing(null); setRescanning(editingChannel.channel_id) }}
        />
      )}
      {rescanChannel && <RescanWeixinDialog channel={rescanChannel} onClose={() => setRescanning(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={open => { if (!open) setDeleting(null) }}
        title={`Delete ${deleting?.name ?? "channel"}?`}
        description={`It disconnects from ${deleting ? platformName(deleting.type) : "its chat"}, and its conversation is deleted.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => { if (deleting) await remove(deleting); setDeleting(null) }}
      />
      <ConfirmDialog
        open={clearing !== null}
        onOpenChange={open => { if (!open) setClearing(null) }}
        title={`Clear ${clearing?.name ?? "the conversation"}?`}
        description="The whole conversation is deleted; the next message starts a new one. The channel stays connected."
        confirmLabel="Clear"
        destructive
        onConfirm={async () => { if (clearing) await clear(clearing); setClearing(null) }}
      />
    </div>
  )
}
