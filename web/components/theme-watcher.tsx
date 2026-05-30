"use client"

import { useEffect } from "react"
import { applyTheme, readStoredTheme } from "@/lib/theme"

// Always mounted (rendered in app/layout.tsx) so the app keeps following the OS
// color scheme while the preference is "system" — even when the settings
// popover that hosts ThemeToggle is closed. The toggle's own listener only
// exists while that popover is open, which is why an OS flip otherwise didn't
// take effect until the user reopened settings.
export function ThemeWatcher() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      if (readStoredTheme() === "system") applyTheme("system")
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return null
}
