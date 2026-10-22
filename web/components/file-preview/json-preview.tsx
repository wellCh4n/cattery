"use client"

import { useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { TextPreview } from "./text-preview"
import { cn } from "@/lib/utils"

const PAGE_SIZE = 100

export function JsonPreview({ content, path, truncated }: {
  content: string
  path: string
  truncated: boolean
}) {
  const parsed = useMemo(() => {
    if (truncated) return { error: "This file was truncated. Download the full file to preview its JSON." }
    try {
      return { value: JSON.parse(content.replace(/^\uFEFF/, "")) as unknown }
    } catch {
      return { error: "Invalid JSON. Showing the original source below." }
    }
  }, [content, truncated])

  if ("error" in parsed) {
    return (
      <div>
        <p role="status" className="border-b p-3 text-amber-700 dark:text-amber-400">{parsed.error}</p>
        <TextPreview path={path} content={content} />
      </div>
    )
  }

  return (
    <div className="p-4 font-mono text-sm leading-6">
      <JsonNode key={content} value={parsed.value} depth={0} />
    </div>
  )
}

export function JsonNode({ value, label, depth }: { value: unknown; label?: string; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const prefix = label === undefined ? null : <span className="text-foreground">{label}: </span>

  if (value === null || typeof value !== "object") {
    return (
      <div className="min-w-0 py-0.5 pl-5 [overflow-wrap:anywhere]">
        {prefix}
        <span className={cn(
          typeof value === "string" ? "text-emerald-700 dark:text-emerald-400" :
            typeof value === "number" ? "text-blue-700 dark:text-blue-400" : "text-violet-700 dark:text-violet-400",
        )}>{JSON.stringify(value)}</span>
      </div>
    )
  }

  const array = Array.isArray(value)
  const keys = array ? null : Object.keys(value)
  const count = array ? value.length : keys!.length
  const open = array ? "[" : "{"
  const close = array ? "]" : "}"
  if (count === 0) return <div className="py-0.5 pl-5 [overflow-wrap:anywhere]">{prefix}{open}{close}</div>

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}
        className="flex w-full cursor-pointer items-start rounded-sm py-0.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight aria-hidden="true" className={cn("mt-1 size-4 shrink-0 transition-transform", expanded && "rotate-90")} />
        <span className="min-w-0 pl-1 [overflow-wrap:anywhere]">
          {prefix}{open}{!expanded && `…${close}`}
          <span className="ml-2 text-xs text-muted-foreground">{count} {array ? "items" : "properties"}</span>
        </span>
      </button>
      {expanded && (
        <div className="ml-2 border-l pl-3">
          {Array.from({ length: Math.min(count, visibleCount) }, (_, index) => {
            const key = array ? index : keys![index]
            return <JsonNode
              key={key}
              label={array ? String(index) : JSON.stringify(key)}
              value={array ? value[index] : (value as Record<string, unknown>)[key]}
              depth={depth + 1}
            />
          })}
          {visibleCount < count && (
            <button type="button" className="cursor-pointer rounded-md px-2 py-1 text-xs text-primary hover:bg-muted"
              onClick={() => setVisibleCount(current => current + PAGE_SIZE)}>
              Show next {Math.min(PAGE_SIZE, count - visibleCount)} ({count - visibleCount} remaining)
            </button>
          )}
          <div>{close}</div>
        </div>
      )}
    </div>
  )
}
