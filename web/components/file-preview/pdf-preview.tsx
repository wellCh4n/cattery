import type { FilePreviewProps } from "./types"

// pdfViewerURL opens the browser PDF viewer with its sidebar closed (Chrome:
// navpanes, Firefox: pagemode) so the page fills the pane; the toolbar stays,
// and its menu button still opens the outline and thumbnails.
export function pdfViewerURL(url: string): string {
  return `${url}#navpanes=0&pagemode=none`
}

export function PdfPreview({ path, rawPathURL }: FilePreviewProps) {
  return <iframe src={pdfViewerURL(rawPathURL)} title={path} className="h-full w-full border-0 bg-muted" />
}
