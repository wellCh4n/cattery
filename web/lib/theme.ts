// Theme preference helpers shared by the ThemeToggle (settings UI) and the
// always-mounted ThemeWatcher. localStorage is the single source of truth; a
// pre-hydration script in app/layout.tsx applies the initial class so there's
// no flash before React mounts.

export type Theme = "system" | "light" | "dark"

export const THEME_STORAGE_KEY = "cattery.theme"

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system"
  const s = window.localStorage.getItem(THEME_STORAGE_KEY)
  return s === "light" || s === "dark" || s === "system" ? s : "system"
}

export function applyTheme(t: Theme): void {
  const dark = t === "dark" || (t === "system" && systemPrefersDark())
  document.documentElement.classList.toggle("dark", dark)
}
