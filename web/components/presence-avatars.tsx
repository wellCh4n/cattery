"use client"

import { useEffect } from "react"
import { UserAvatar } from "@/components/user-avatar"
import { Hint } from "@/components/ui/hint"
import { useAuthStore } from "@/lib/auth-store"
import { type PresenceUser, useLiveStore, watchProject } from "@/lib/live"
import { profileName } from "@/lib/profile"

// Shown before an overflow count.
const MAX_SHOWN = 5
const EMPTY: PresenceUser[] = []

// The other members who have the project open right now, beside the user's
// own avatar. Watching the project is what announces this user to them.
export function PresenceAvatars({ projectId }: { projectId: string }) {
  const selfId = useAuthStore(s => s.user?.user_id)
  const users = useLiveStore(s => s.presence[projectId] ?? EMPTY)

  useEffect(() => watchProject(projectId), [projectId])

  const others = users.filter(u => u.user_id !== selfId)
  if (others.length === 0) return null
  const shown = others.slice(0, MAX_SHOWN)
  const hidden = others.slice(MAX_SHOWN)
  return (
    <div className="flex shrink-0 items-center -space-x-1.5" aria-label="Online in this project">
      {shown.map(user => (
        <Hint key={user.user_id} label={`${profileName(user)} is here`} side="bottom">
          <span className="flex rounded-full ring-2 ring-background">
            <UserAvatar {...user} className="size-7 text-[11px]" />
          </span>
        </Hint>
      ))}
      {hidden.length > 0 && (
        <Hint label={hidden.map(u => profileName(u)).join(", ")} side="bottom">
          <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground ring-2 ring-background">
            +{hidden.length}
          </span>
        </Hint>
      )}
    </div>
  )
}
