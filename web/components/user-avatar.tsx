"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { fetchAvatar } from "@/lib/api"
import { profileName, type UserIdentity } from "@/lib/profile"
import { useUserProfile } from "@/lib/use-user-profile"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { UserCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

// avatarHue maps a username to a hue (0–359) with 32-bit FNV-1a, so a given
// name gets the same color everywhere and across reloads. Case and surrounding
// spaces don't change it.
export function avatarHue(username: string): number {
  let hash = 0x811c9dc5
  for (const ch of username.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 360
}

export function UserAvatar({ className, ...identity }: UserIdentity & { className?: string }) {
  const profile = useUserProfile(identity)
  const name = profileName(profile)
  const userId = profile.user_id
  const version = profile.avatar_version
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
  const key = `${userId}:${version}`
  useEffect(() => {
    if (!userId || !version) return
    const controller = new AbortController()
    let url: string | undefined
    fetchAvatar(userId, version, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      setLoaded({ key, url })
    }).catch(() => { /* Keep the generated avatar on network or image errors. */ })
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [userId, version, key])
  const hasName = Boolean(profile.name?.trim() || profile.username?.trim())
  const initial = Array.from(name)[0]?.toUpperCase()
  return (
    <Avatar aria-label={name} style={{ "--avatar-hue": avatarHue(profile.username || name) } as CSSProperties} className={cn("size-4 text-[9px] font-semibold leading-none", className)}>
      {loaded?.key === key && version && <AvatarImage src={loaded.url} alt={name} />}
      <AvatarFallback className={cn(
        "text-[length:inherit]",
        hasName ? "bg-[oklch(0.9_0.07_var(--avatar-hue))] text-[oklch(0.42_0.12_var(--avatar-hue))] dark:bg-[oklch(0.38_0.09_var(--avatar-hue))] dark:text-[oklch(0.92_0.05_var(--avatar-hue))]" : "bg-background text-muted-foreground",
      )}>
        {hasName ? initial : <UserCircle2 className="size-3.5" />}
      </AvatarFallback>
    </Avatar>
  )
}
