"use client"

import { useEffect, useRef, useState } from "react"
import { Download } from "lucide-react"
import { exportSessionURL } from "@/lib/api"
import { cn } from "@/lib/utils"

export function ExportMenu({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        title="Export transcript"
        aria-label="Export transcript"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={cn(
          "flex size-6 items-center justify-center rounded text-muted-foreground transition-colors cursor-pointer hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        <Download className="size-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-20 mb-1 w-56 overflow-hidden rounded-md border bg-popover text-sm shadow-md"
        >
          <a
            href={exportSessionURL(sessionId, "md")}
            download
            onClick={() => setOpen(false)}
            className="grid h-9 cursor-pointer grid-cols-[3rem_1fr] items-center px-3 hover:bg-muted"
          >
            <span className="text-[10px] font-medium text-muted-foreground">MD</span>
            <span className="whitespace-nowrap">Markdown transcript</span>
          </a>
          <a
            href={exportSessionURL(sessionId, "json")}
            download
            onClick={() => setOpen(false)}
            className="grid h-9 cursor-pointer grid-cols-[3rem_1fr] items-center px-3 hover:bg-muted"
          >
            <span className="text-[10px] font-medium text-muted-foreground">JSON</span>
            <span className="whitespace-nowrap">Raw history</span>
          </a>
        </div>
      )}
    </div>
  )
}
