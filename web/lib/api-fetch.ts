import { getStoredToken, setStoredToken } from "./auth-token"

export class UnauthorizedError extends Error {
  constructor() { super("unauthorized") }
}

// redirecting guards against the thundering-herd case: if many in-flight
// requests all get 401 at once we'd otherwise clear the token N times,
// assign window.location.href N times, and dump N UnauthorizedErrors into
// the console. We still throw — callers' Promise chains need to settle —
// but the token clear / navigation only fires once.
let redirecting = false

// authedFetch attaches the Bearer token to every request and centralizes
// the 401 → logout flow. We deliberately do NOT throw on every non-2xx:
// callers already have their own error messages. We only throw the typed
// UnauthorizedError so the auth-store can react.
export async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getStoredToken()
  const headers = new Headers(init?.headers)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) {
    if (!redirecting) {
      redirecting = true
      setStoredToken(null)
      // Hard reload — simpler than threading a router through every API
      // helper, and the workspace store / chat streams need a clean slate
      // anyway.
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login"
      }
    }
    throw new UnauthorizedError()
  }
  return res
}
