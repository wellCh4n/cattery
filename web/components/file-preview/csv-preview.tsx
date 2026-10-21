"use client"

import { useMemo, useState } from "react"
import { parseCsv } from "@/lib/csv"
import { TextPreview } from "./text-preview"
import type { FilePreviewProps } from "./types"

const PAGE_SIZE = 100

export function CsvPreview({ path, content, truncated }: FilePreviewProps) {
  const parsed = useMemo(() => parseCsv(content), [content])
  const error = truncated
    ? "This file was truncated. Download the full file to preview its CSV."
    : parsed.error

  if (error) return (
    <div>
      <p role="status" className="border-b p-3 text-amber-700 dark:text-amber-400">{error}</p>
      <TextPreview path={path} content={content} />
    </div>
  )
  if (!parsed.rows?.length) return <p className="p-4 text-muted-foreground">Empty CSV file.</p>
  return <CsvTable key={content} rows={parsed.rows} limited={parsed.limited} />
}

function CsvTable({ rows, limited }: { rows: string[][]; limited: boolean }) {
  const [page, setPage] = useState(0)
  const [hasHeader, setHasHeader] = useState(true)
  const columns = Math.max(...rows.map(row => row.length))
  const data = hasHeader ? rows.slice(1) : rows
  const pages = Math.max(1, Math.ceil(data.length / PAGE_SIZE))
  const visible = data.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const cellClass = "max-w-96 min-w-24 whitespace-pre-wrap break-words border-b border-r px-3 py-2 text-left align-top"

  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-3 border-b bg-background px-3 py-2 text-xs text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={hasHeader} onChange={event => { setHasHeader(event.target.checked); setPage(0) }} />
          First row as header
        </label>
        {limited && <span role="status">Preview limited to the first {rows.length} records.</span>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)} className="cursor-pointer rounded border px-2 py-1 disabled:cursor-default disabled:opacity-40">Previous</button>
          <span>Page {page + 1} / {pages}</span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)} className="cursor-pointer rounded border px-2 py-1 disabled:cursor-default disabled:opacity-40">Next</button>
        </div>
      </div>
      <table className="w-full border-separate border-spacing-0">
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th scope="col" className="border-b border-r px-2 py-2 text-right font-normal text-muted-foreground">#</th>
            {Array.from({ length: columns }, (_, index) => (
              <th scope="col" key={index} className={`${cellClass} font-medium`}>
                {hasHeader ? rows[0][index] ?? "" : `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={page * PAGE_SIZE + index} className="hover:bg-muted/40">
              <th scope="row" className="border-b border-r px-2 py-2 text-right align-top font-mono text-xs font-normal text-muted-foreground">{page * PAGE_SIZE + index + (hasHeader ? 2 : 1)}</th>
              {Array.from({ length: columns }, (_, column) => <td key={column} className={cellClass}>{row[column] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
