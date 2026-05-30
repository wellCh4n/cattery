"use client"

import { useEffect, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"
import { type Theme, THEME_STORAGE_KEY, applyTheme, readStoredTheme } from "@/lib/theme"

const OPTIONS: { value: Theme; label: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
]

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // The pre-hydration script in app/layout.tsx already applied the right
    // class to <html>; this only syncs React's idea of the preference. Live
    // "system" following is handled globally by ThemeWatcher, not here.
    const initial = readStoredTheme()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial)
    applyTheme(initial)
    setMounted(true)
  }, [])

  function choose(next: Theme) {
    setTheme(next)
    applyTheme(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mounted && theme === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            title={label}
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "flex size-5 cursor-pointer items-center justify-center rounded transition-colors",
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
