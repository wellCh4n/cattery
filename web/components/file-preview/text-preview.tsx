import { FileViewer } from "@/components/file-viewer"
import type { FilePreviewProps } from "./types"

export function TextPreview({ path, content }: Pick<FilePreviewProps, "path" | "content">) {
  return <FileViewer path={path} lines={content.split("\n").map((text, i) => ({ n: i + 1, text }))} />
}
