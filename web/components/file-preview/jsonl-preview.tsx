"use client"

import { useMemo, useState } from "react"
import { parseJsonl, type JsonlResult } from "@/lib/jsonl"
import { JsonNode } from "./json-preview"
import type { FilePreviewProps } from "./types"

const PAGE_SIZE = 100

export function JsonlPreview({ content, truncated }: FilePreviewProps) {
  const parsed = useMemo(() => parseJsonl(content, { truncated }), [content, truncated])
  return <JsonlRecords key={`${truncated}:${content}`} parsed={parsed} truncated={truncated} />
}

function JsonlRecords({ parsed: { entries, limited }, truncated }: { parsed: JsonlResult; truncated: boolean }) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const visible = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const errors = entries.filter(entry => entry.error).length

  return (
    <div className="text-sm">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background px-3 py-2 text-xs text-muted-foreground">
        <span>{entries.length} {entries.length === 1 ? "record" : "records"}{errors > 0 && `, ${errors} invalid`}</span>
        {pages > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)} className="cursor-pointer rounded-md border px-2 py-1 disabled:cursor-default disabled:opacity-40">Previous</button>
            <span>Page {page + 1} / {pages}</span>
            <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)} className="cursor-pointer rounded-md border px-2 py-1 disabled:cursor-default disabled:opacity-40">Next</button>
          </div>
        )}
      </div>
      {(limited || truncated) && (
        <p role="status" className="border-b p-3 text-amber-700 dark:text-amber-400">
          {limited ? `Preview limited to the first ${entries.length} records. ` : "This file was truncated. Only complete lines are shown. "}
          Download to view the full file.
        </p>
      )}
      {entries.length === 0 ? (
        <p className="p-4 text-muted-foreground">{truncated ? "No complete records in the preview." : "No JSON records. The file is empty or contains only blank lines."}</p>
      ) : visible.map(entry => (
        <section key={entry.line} aria-label={`Line ${entry.line}`} className="border-b px-3 py-2">
          <div className="mb-1 font-mono text-xs text-muted-foreground">Line {entry.line}</div>
          {entry.error ? (
            <div>
              <p className="text-destructive">{entry.error}</p>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{entry.source}</pre>
            </div>
          ) : (
            <div className="font-mono leading-6"><JsonNode value={entry.value} depth={1} /></div>
          )}
        </section>
      ))}
    </div>
  )
}
