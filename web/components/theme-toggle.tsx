"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

type Theme = "light" | "dark"

const STORAGE_KEY = "cattery.theme"

function applyTheme(t: Theme) {
  const root = document.documentElement
  root.classList.toggle("dark", t === "dark")
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "light"
  const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null
  if (stored === "light" || stored === "dark") return stored
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // Read theme from localStorage on mount. We can't use lazy initial
    // state because that would force the SSR render to read window/
    // localStorage (mismatch). The pre-hydration script in app/layout.tsx
    // already applied the right class to <html>, so this setState only
    // syncs React's idea of the theme — no visual flicker.
    const initial = readInitialTheme()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial)
    applyTheme(initial)
    setMounted(true)
  }, [])

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark"
    setTheme(next)
    applyTheme(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggle}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      aria-label="Toggle theme"
    >
      {mounted && theme === "dark" ? <Moon /> : <Sun />}
    </Button>
  )
}
