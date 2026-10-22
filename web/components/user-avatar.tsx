import { UserCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

export function UserAvatar({ username, className }: { username?: string | null; className?: string }) {
  const initial = Array.from(username?.trim() ?? "")[0]?.toUpperCase()
  return (
    <span
      role="img"
      aria-label={username || "Unknown user"}
      title={username || "Unknown user"}
      className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[9px] font-semibold leading-none text-muted-foreground", className)}
    >
      {initial || <UserCircle2 className="size-3.5" />}
    </span>
  )
}
