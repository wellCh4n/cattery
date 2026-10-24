"use client"

import { use, useState } from "react"
import { ExternalLink, Globe, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { previewURL } from "@/lib/api"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  projectId: string
  port: string
}

// A web server in the project sandbox, framed from the backend's preview
// proxy. The frame is another origin, so its location can't be read back:
// the address field shows the last path opened from here.
export default function PortPage({ params, searchParams }: {
  params: Promise<PageParams>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { projectId, port } = use(params)
  const query = use(searchParams)
  const initialPath = typeof query.path === "string" && query.path.startsWith("/") ? query.path : "/"
  const [path, setPath] = useState(initialPath)
  const [draft, setDraft] = useState(initialPath)
  // Remounting the frame reloads it with a fresh sign-in.
  const [loads, setLoads] = useState(0)
  // A link opened from chat arrives as a new ?path= on the same tab.
  const [seenPath, setSeenPath] = useState(initialPath)
  if (initialPath !== seenPath) {
    setSeenPath(initialPath)
    setPath(initialPath)
    setDraft(initialPath)
    setLoads(n => n + 1)
  }

  useDocumentTitle(`Port ${port}`)

  function go(next: string) {
    const normalized = next.startsWith("/") ? next : `/${next}`
    setPath(normalized)
    setDraft(normalized)
    setLoads(n => n + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <form
          className="flex min-w-0 flex-1 items-center rounded-md border bg-muted/30 px-2 font-mono text-xs focus-within:ring-1 focus-within:ring-ring"
          onSubmit={e => { e.preventDefault(); go(draft.trim() || "/") }}
        >
          <span className="shrink-0 text-muted-foreground">localhost:{port}</span>
          <input
            aria-label="Path"
            className="h-6 min-w-0 flex-1 bg-transparent outline-none"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
          />
        </form>
        <Hint label="Reload">
          <Button variant="ghost" size="icon-sm" aria-label="Reload" onClick={() => setLoads(n => n + 1)}>
            <RotateCw />
          </Button>
        </Hint>
        <Hint label="Open in a new browser tab">
          <Button variant="ghost" size="icon-sm" aria-label="Open in a new browser tab" onClick={() => window.open(previewURL(projectId, port, path), "_blank", "noopener")}>
            <ExternalLink />
          </Button>
        </Hint>
      </div>
      <iframe
        key={loads}
        title={`Port ${port}`}
        src={previewURL(projectId, port, path)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  )
}
