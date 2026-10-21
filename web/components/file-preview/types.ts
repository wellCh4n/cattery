import type { ComponentType } from "react"

export interface FilePreviewProps {
  projectId: string
  path: string
  content: string
  truncated: boolean
  rawURL: string
  rawPathURL: string
}

export interface FilePreviewDefinition {
  id: string
  extensions: readonly string[]
  /** Content renderers wait for readFile; URL renderers stream directly. */
  input: "content" | "url"
  supportsSource: boolean
  component: ComponentType<FilePreviewProps>
}
