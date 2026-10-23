"use client"

import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

// Plays one full turn of the icon each time a refresh starts — a click, or a
// panel reloading when its view is shown — and stays disabled while it runs.
// Remounting the icon restarts the animation.
export function RefreshButton({ refreshing, ...props }: React.ComponentProps<typeof Button> & { refreshing: boolean }) {
  const [turns, setTurns] = useState(0)
  const [wasRefreshing, setWasRefreshing] = useState(false)
  if (refreshing !== wasRefreshing) {
    setWasRefreshing(refreshing)
    if (refreshing) setTurns(n => n + 1)
  }
  return (
    <Button variant="ghost" size="icon-sm" disabled={refreshing} {...props}>
      <RefreshCw key={turns} className={turns ? "animate-[spin_1s_ease-in-out]" : undefined} />
    </Button>
  )
}
