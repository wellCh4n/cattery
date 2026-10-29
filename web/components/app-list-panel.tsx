"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { ExternalLink, AppWindow, Loader2, Power } from "lucide-react"
import { RefreshButton } from "@/components/refresh-button"
import { Tree, type TreeNode } from "@/components/tree"
import { TreeRowAction } from "@/components/tree-row"
import { Hint } from "@/components/ui/hint"
import { previewURL, stopApp } from "@/lib/api"
import { usePreviewTemplate } from "@/lib/server-config"
import { useAppsStore } from "@/lib/apps-store"
import { tabForPath } from "@/lib/tabs-store"
import { formatUptime } from "@/lib/uptime"

// Servers listening in the project sandbox, each opening a preview tab. They
// come from the sandbox's socket table, so servers started by the agent, a
// terminal or anything else show up within a few seconds. The live channel
// pushes the list; this view only reads it.
export function AppListPanel({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const previewTemplate = usePreviewTemplate()
  const loaded = useAppsStore(s => s.projectId === projectId)
  const apps = useAppsStore(s => (loaded ? s.apps : null))
  // Running times tick here; the list itself changes only when pushed.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const listError = useAppsStore(s => (loaded ? s.error : null))
  const refreshing = useAppsStore(s => loaded && s.refreshing)
  const loadApps = useAppsStore(s => s.load)
  const load = () => loadApps(projectId)
  const [stopError, setStopError] = useState<string | null>(null)
  const error = stopError ?? listError
  // The port being stopped; the stop waits for the process to exit.
  const [stopping, setStopping] = useState<number | null>(null)

  async function stop(port: number) {
    setStopping(port)
    setStopError(null)
    try {
      await stopApp(projectId, port)
      await load()
    } catch (err) {
      setStopError(err instanceof Error ? err.message : `Failed to stop port ${port}`)
    } finally {
      setStopping(null)
    }
  }

  const route = tabForPath(pathname ?? "")
  const selected = route?.kind === "port" && route.projectId === projectId ? route.id : null

  const items: TreeNode[] = (apps ?? []).map(app => {
    const uptime = formatUptime(app.started_at, now)
    return {
      id: `p-${app.port}`,
      expandable: false,
      selected: selected === String(app.port),
      rowClassName: "h-14 items-start py-1.5",
      onClick: () => router.push(`/ports/${projectId}/${app.port}`),
      body: (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex h-6 min-w-0 items-center gap-1.5">
            <span className="flex size-4 shrink-0 items-center justify-center"><AppWindow className="size-4 text-muted-foreground" /></span>
            <span className="min-w-0 flex-1 truncate">Port {app.port}</span>
            {uptime && (
              <time className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground group-hover/treerow:hidden" dateTime={app.started_at}>
                {uptime}
              </time>
            )}
            <TreeRowAction
              aria-label="Open in a new browser tab"
              onClick={e => { e.stopPropagation(); if (previewTemplate) window.open(previewURL(projectId, app.port, "/", previewTemplate), "_blank", "noopener") }}
            >
              <ExternalLink className="size-4" />
            </TreeRowAction>
            {/* Only a process the agent container can see can be stopped. */}
            {app.pid !== undefined && (
              <TreeRowAction
                destructive
                aria-label={`Stop the app on port ${app.port}`}
                disabled={stopping !== null}
                onClick={e => { e.stopPropagation(); void stop(app.port) }}
              >
                {stopping === app.port ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
              </TreeRowAction>
            )}
          </span>
          <span className="flex h-4 min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <Hint label={app.command}>
              <span className="min-w-0 flex-1 truncate font-mono">{app.command}</span>
            </Hint>
            {app.pid !== undefined && (
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground">PID {app.pid}</span>
            )}
          </span>
        </span>
      ),
    }
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Apps</span>
        <RefreshButton aria-label="Refresh apps" refreshing={refreshing} onClick={() => void load()} />
      </div>
      {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {apps === null && !error ? (
          <div className="flex h-12 items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : apps?.length ? (
          <Tree items={items} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <AppWindow className="size-8 text-muted-foreground opacity-50" />
            <p className="mt-2 text-xs text-muted-foreground">No apps running</p>
            <p className="mt-1 text-xs text-muted-foreground">Start a web server in the sandbox and it shows up here.</p>
          </div>
        )}
      </div>
    </div>
  )
}
