import { HtmlPreview } from "./html-preview"
import { CsvPreview } from "./csv-preview"
import { ImagePreview } from "./image-preview"
import { JsonPreview } from "./json-preview"
import { MarkdownPreview } from "./markdown-preview"
import { PdfPreview } from "./pdf-preview"
import { TextPreview } from "./text-preview"
import type { FilePreviewDefinition } from "./types"

export const textPreview: FilePreviewDefinition = {
  id: "text",
  extensions: [],
  input: "content",
  supportsSource: false,
  component: TextPreview,
}

// Register new formats here. First matching entry wins; unknown extensions
// fall back to textPreview, which also renders every format's Source mode.
export const filePreviews: readonly FilePreviewDefinition[] = [
  {
    id: "image",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"],
    input: "url",
    supportsSource: false,
    component: ImagePreview,
  },
  { id: "pdf", extensions: ["pdf"], input: "url", supportsSource: false, component: PdfPreview },
  { id: "html", extensions: ["html", "htm"], input: "url", supportsSource: true, component: HtmlPreview },
  {
    id: "markdown",
    extensions: ["md", "markdown", "mdown", "mkd"],
    input: "content",
    supportsSource: true,
    component: MarkdownPreview,
  },
  { id: "json", extensions: ["json"], input: "content", supportsSource: true, component: JsonPreview },
  { id: "csv", extensions: ["csv"], input: "content", supportsSource: true, component: CsvPreview },
]

export function previewForPath(path: string): FilePreviewDefinition {
  const filename = path.slice(path.lastIndexOf("/") + 1)
  const dot = filename.lastIndexOf(".")
  const extension = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase()
  return filePreviews.find(preview => preview.extensions.includes(extension)) ?? textPreview
}
