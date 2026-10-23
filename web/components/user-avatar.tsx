import type { CSSProperties } from "react"
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

export function UserAvatar({ username, className }: { username?: string | null; className?: string }) {
  const name = username?.trim() ?? ""
  const initial = Array.from(name)[0]?.toUpperCase()

  if (!initial) {
    return (
      <span
        role="img"
        aria-label="Unknown user"
        className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground", className)}
      >
        <UserCircle2 className="size-3.5" />
      </span>
    )
  }

  // A soft tint of the name's hue with a darker letter in the same hue; the
  // dark theme flips to a deep tint with a light letter.
  return (
    <span
      role="img"
      aria-label={name}
      style={{ "--avatar-hue": avatarHue(name) } as CSSProperties}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none select-none",
        "bg-[oklch(0.9_0.07_var(--avatar-hue))] text-[oklch(0.42_0.12_var(--avatar-hue))]",
        "dark:bg-[oklch(0.38_0.09_var(--avatar-hue))] dark:text-[oklch(0.92_0.05_var(--avatar-hue))]",
        className,
      )}
    >
      {initial}
    </span>
  )
}
