import type { ReactNode } from "react"
import { UserAvatar } from "@/components/user-avatar"

function formatItemTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

// Both lines use the full row width; the leading icon belongs to the title line.
export function WorkspaceItemBody({ icon, title, accessory, actions, creator, timestamp }: {
  icon: ReactNode
  title: string
  accessory?: ReactNode
  actions?: ReactNode
  creator: string | null
  timestamp: string
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex h-6 min-w-0 items-center gap-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
        {accessory && <span className="flex shrink-0 items-center group-hover/treerow:hidden">{accessory}</span>}
        {actions}
      </span>
      <span className="flex h-4 min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
        <UserAvatar username={creator} />
        <span className="min-w-0 flex-1 truncate" title={creator ? `Created by ${creator}` : "Creator unknown"}>
          {creator || "Unknown creator"}
        </span>
        <time className="shrink-0 font-mono tabular-nums text-muted-foreground/70" dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
          {formatItemTime(timestamp)}
        </time>
      </span>
    </span>
  )
}
