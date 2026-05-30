"use client"

import { use } from "react"
import { FileView } from "@/components/file-view"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  projectId: string
  path: string[]
}

export default function FilePage({ params }: { params: Promise<PageParams> }) {
  const { projectId, path } = use(params)
  // Catch-all segments arrive percent-encoded in this Next version; decode each
  // before rebuilding the absolute workspace path (non-ASCII names like 中文).
  const segments = (path ?? []).map(decodeURIComponent)
  const filePath = "/" + segments.join("/")
  const name = segments[segments.length - 1] ?? filePath

  useDocumentTitle(name)

  return <FileView key={`${projectId}:${filePath}`} projectId={projectId} path={filePath} />
}
