"use client"

// RightRail wraps the session-page main content with an IDEA-style right rail:
// a 36px icon strip on the far right that's always visible, plus an optional
// panel that slides in to its left when an icon is toggled. Only one panel can
// be open at a time. The panel is horizontally resizable by dragging its left
// edge; width persists in localStorage so it survives navigation.

import { useState } from "react"
import { FolderOpen, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { useResizable } from "@/lib/use-resizable"
import { HarnessInfoPanel } from "@/components/harness-info-panel"
import { FileBrowserPanel } from "@/components/file-browser-panel"
import type { Harness, Session } from "@/lib/api"

type PanelId = "info" | "files"

interface Props {
  harness: Harness
  session: Session
  children: React.ReactNode
}

const MIN_WIDTH = 240
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 360
const WIDTH_KEY = "cattery:rightrail:width"

export function RightRail({ harness, session, children }: Props) {
  const [active, setActive] = useState<PanelId | null>(null)
  const { width, onMouseDown } = useResizable({
    initial: DEFAULT_WIDTH,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    storageKey: WIDTH_KEY,
    side: "left",
  })

  function toggle(id: PanelId) {
    setActive(prev => prev === id ? null : id)
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex-1 min-w-0 overflow-hidden">{children}</div>

      {active !== null && (
        <div
          className="relative flex h-full shrink-0 border-l bg-background"
          style={{ width }}
        >
          {/* drag handle */}
          <div
            onMouseDown={onMouseDown}
            className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors -translate-x-1/2 z-10"
          />
          <div className="flex-1 min-w-0 overflow-hidden">
            {active === "info" && <HarnessInfoPanel harness={harness} session={session} />}
            {active === "files" && <FileBrowserPanel harness={harness} />}
          </div>
        </div>
      )}

      {/* always-visible icon strip */}
      <div className="flex h-full w-9 shrink-0 flex-col items-center border-l bg-sidebar py-2 gap-1">
        <RailButton
          icon={<Info className="size-4" />}
          label="Harness info"
          active={active === "info"}
          onClick={() => toggle("info")}
        />
        <RailButton
          icon={<FolderOpen className="size-4" />}
          label="Files"
          active={active === "files"}
          onClick={() => toggle("files")}
        />
      </div>
    </div>
  )
}

function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded transition-colors cursor-pointer",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {icon}
    </button>
  )
}
