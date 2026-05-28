"use client"

import { useEffect, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"

type Theme = "system" | "light" | "dark"

const STORAGE_KEY = "cattery.theme"

const OPTIONS: { value: Theme; label: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
]

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && systemPrefersDark())
  document.documentElement.classList.toggle("dark", dark)
}

function readStored(): Theme {
  if (typeof window === "undefined") return "system"
  const s = window.localStorage.getItem(STORAGE_KEY)
  return s === "light" || s === "dark" || s === "system" ? s : "system"
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // The pre-hydration script in app/layout.tsx already applied the right
    // class to <html>; this only syncs React's idea of the preference.
    const initial = readStored()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial)
    applyTheme(initial)
    setMounted(true)
  }, [])

  // While following the system, re-apply when the OS scheme flips.
  useEffect(() => {
    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyTheme("system")
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [theme])

  function choose(next: Theme) {
    setTheme(next)
    applyTheme(next)
    window.localStorage.setItem(STORAGE_KEY, next)
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
