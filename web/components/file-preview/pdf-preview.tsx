import type { FilePreviewProps } from "./types"

export function PdfPreview({ path, rawPathURL }: FilePreviewProps) {
  return <iframe src={rawPathURL} title={path} className="h-full w-full border-0 bg-muted" />
}
