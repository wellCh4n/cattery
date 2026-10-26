// Links the agent writes to servers in its sandbox (http://localhost:5173/…)
// mean nothing in the user's browser; they open as port previews instead.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"])
// The agent's port is the platform's own, never a preview.
const RESERVED_PORTS = new Set([1114])

export interface SandboxLink {
  port: number
  // Path, query and hash below the preview root.
  path: string
}

export function parseSandboxLink(href: string | undefined): SandboxLink | null {
  if (!href) return null
  let url: URL
  try { url = new URL(href) } catch { return null }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOCAL_HOSTS.has(url.hostname)) return null
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  if (RESERVED_PORTS.has(port)) return null
  return { port, path: url.pathname + url.search + url.hash }
}

// In-app route of a port preview tab; the path rides as ?path=.
export function previewHref(projectId: string, link: SandboxLink): string {
  const base = `/ports/${projectId}/${link.port}`
  return link.path === "/" ? base : `${base}?path=${encodeURIComponent(link.path)}`
}
