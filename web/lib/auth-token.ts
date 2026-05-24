// Shared token storage so url builders (rawFileURL, termURL) and the fetch
// wrapper can both reach it without going through zustand. localStorage is
// fine here: this is a single-page internal tool, not a shared device.
const TOKEN_KEY = "cattery.token"

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(TOKEN_KEY)
}

export function setStoredToken(token: string | null) {
  if (typeof window === "undefined") return
  if (token === null) localStorage.removeItem(TOKEN_KEY)
  else localStorage.setItem(TOKEN_KEY, token)
}
